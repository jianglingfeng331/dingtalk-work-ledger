import axios from 'axios'
import { getAccessToken } from './dingtalk.js'
import { getTable } from './settings.js'
import { withRetry } from '../utils/retry.js'

/**
 * 钉钉AI表格（Notable 多维表）适配器
 * 官方接口：/v1.0/notable/bases/{baseId}/sheets/{sheetIdOrName}/records
 * 所有请求必填 operatorId（操作人 unionId）：优先当前登录用户，兜底设置页配置
 *
 * 目标表「工作日志表」真实表头（API读取校准）：
 *   日期(date) 成员(user) 所属小组(singleSelect) 工作内容(text)
 *   耗时(number) 关联任务(text) 产出物(text) 完成情况(singleSelect: 未开始/进行中/已完成)
 * 任务表表头：任务名称(text) 负责人(user) 状态 状态(singleSelect) 计划节点(date) ...
 */
const HTTP = axios.create({ timeout: 10000 })

/** 多项目缓存分桶：projectId → 各类缓存（避免项目间串数据） */
const buckets = new Map()
function bucketOf(projectId) {
  const key = projectId || '_'
  if (!buckets.has(key))
    buckets.set(key, { records: null, tasks: null, members: null, taskFields: null, linkColType: null, directives: null })
  return buckets.get(key)
}
/** 项目内某桶缓存失效（写成功后调用） */
function invalidate(projectId, ...keys) {
  const b = buckets.get(projectId || '_')
  if (!b) return
  keys.forEach((k) => {
    b[k] = null
  })
}

const BASE = (projectId) =>
  `https://api.dingtalk.com/v1.0/notable/bases/${getTable(projectId).baseId}/sheets/${encodeURIComponent(getTable(projectId).sheetId)}/records`

// 字段映射：业务字段名 → 日志表列名（设置页可改）
const COLS = {
  taskDate: '日期',
  recorder: '成员', // user类型：写 [{unionId}]，缺unionId时降级不写该列
  rawContent: '工作内容',
  hours: '耗时',
  progress: '完成情况',
  linkTask: '关联任务', // text类型：写任务名软关联
}

/** 解析操作人 unionId：当前用户优先，兜底项目配置 */
function requireOperatorId(explicit, projectId) {
  const op = explicit || getTable(projectId).operatorUnionId || ''
  if (!op) {
    throw new Error('缺少操作人UnionId：请在钉钉内打开本应用（自动获取），或由管理员在设置页项目管理中填写')
  }
  return op
}

/** 权限兜底：钉钉对无表格访问权的操作人返回403/404——自动改用项目配置操作人重试
 *  场景：成员在「项目成员表」但AI表格未共享给他，读任务/成员、写日志/计划仍可用（成员列按本人精确归属） */
async function withPermFallback(operatorId, projectId, fn) {
  const t = getTable(projectId)
  const primary = operatorId || t.operatorUnionId || ''
  try {
    return await fn(primary)
  } catch (err) {
    const status = err?.response?.status
    const fb = t.operatorUnionId || ''
    if ((status === 403 || status === 404) && fb && fb !== primary) {
      console.warn(`[table] 操作人无表格权限(${status})，改用项目操作人重试`)
      return await fn(fb)
    }
    throw err
  }
}

async function headers() {
  const token = await getAccessToken()
  return { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' }
}

/** 日期列兼容：'YYYY-MM-DD HH:mm' 取日期部分；毫秒时间戳转日期 */
const toPlainDate = (v) => {
  if (typeof v === 'number') {
    const d = new Date(v)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return String(v || '').slice(0, 10)
}

const toText = (v) => {
  if (Array.isArray(v)) return v.map((x) => x?.text ?? x).join('')
  return v == null ? '' : String(v)
}

/** 回读兼容：字段值 → 业务字段（关联列返回 linkedRecordIds/记录对象时尽量提取显示名） */
function rowToRecord(f, row) {
  const member = f[COLS.recorder]
  const memberName = Array.isArray(member)
    ? member.map((m) => m?.name || m?.unionId).filter(Boolean).join('、')
    : toText(member)
  // 成员列的unionId：回载记录的用户归属（权限过滤按此识别"本人记录"）
  const memberUnionId = Array.isArray(member) && member[0]?.unionId ? member[0].unionId : ''
  const hoursRaw = f[COLS.hours]
  const linkRaw = f[COLS.linkTask]
  const linkName = Array.isArray(linkRaw)
    ? linkRaw.map((x) => x?.title || x?.name || x?.text || (x?.recordId ? '' : x)).filter(Boolean).join('、')
    : linkRaw?.linkedRecordIds
      ? ''
      : toText(linkRaw)
  const content = toText(f[COLS.rawContent])
  const prog = f[COLS.progress]
  return {
    id: row.id,
    recorder: memberName || '未知成员',
    recordTime: toPlainDate(f[COLS.taskDate]), // 无记录时间列，用日期列
    rawContent: content,
    title: linkName || content.slice(0, 30),
    progress: (prog?.name ?? toText(prog)) || '未开始',
    taskDate: toPlainDate(f[COLS.taskDate]),
    hours: typeof hoursRaw === 'number' ? hoursRaw : Number(hoursRaw) || null,
    tags: [],
    unionId: memberUnionId,
    // 原生关联的任务记录ID（任务视图按此聚合）
    linkTaskRecordIds: Array.isArray(linkRaw?.linkedRecordIds) ? linkRaw.linkedRecordIds : [],
  }
}

/** 新增一行记录（自动重试2次；clientToken=记录ID 保证重试幂等不重复写）
 * 任务关联：按工作内容匹配任务后写入「关联任务」列，列类型自动适配——
 *   关联类型(unidirectional/bidirectionalLink) → 写 {linkedRecordIds:[任务记录ID]}（原生关联：可点击跳转、任务侧聚合）
 *   其他（文本等）→ 写任务名称文字（软关联）
 * 匹配失败/写入异常均不阻断日志入库（失败去掉关联字段重写一次） */
async function writeRecord(record, operatorId, projectId) {
  const fields = {
    [COLS.taskDate]: toPlainDate(record.taskDate),
    [COLS.rawContent]: record.rawContent,
    [COLS.progress]: record.progress || '进行中',
  }
  if (Number.isFinite(Number(record.hours)) && record.hours != null) fields[COLS.hours] = Number(record.hours)
  // 成员列：有 unionId 才写（user类型需精确关联）
  if (record.unionId) fields[COLS.recorder] = [{ unionId: record.unionId }]

  let linkValue = null // null=不关联；string=任务名；object=linkedRecordIds
  let isNativeLink = false
  let linkedTaskRecordId = '' // 实际写入的关联任务记录ID（供指令进展同步联动，未成功写关联时保持空）
  try {
    if (record.taskId) {
      // 用户在页面显式选择了任务：直接按记录ID关联，跳过智能匹配
      const picked = (await fetchTasks(operatorId, projectId)).find((x) => x.recordId === record.taskId)
      if (picked) {
        isNativeLink = await isLinkColumn(operatorId, projectId)
        linkValue = isNativeLink ? { linkedRecordIds: [picked.recordId] } : picked.title
        linkedTaskRecordId = picked.recordId
      } else {
        console.warn('[table] 所选任务不存在（可能已被删除），本次不关联')
      }
    } else {
      // 未显式选择：智能匹配兜底。标题+原始内容合并参与匹配（短标题信息量不足，易漏配）
      const hit = await matchTask(`${record.title || ''}。${record.rawContent || ''}`, operatorId, projectId)
      if (hit) {
        isNativeLink = await isLinkColumn(operatorId, projectId)
        linkValue = isNativeLink ? { linkedRecordIds: [hit.recordId] } : hit.title
        linkedTaskRecordId = hit.recordId
      }
    }
  } catch (err) {
    console.warn('[table] 任务匹配失败（不影响日志入库）:', err?.message)
  }

  const build = () => {
    const f = { ...fields }
    if (linkValue != null) f[COLS.linkTask] = linkValue
    return { records: [{ fields: f }] }
  }

  const query = `operatorId=${encodeURIComponent(requireOperatorId(operatorId, projectId))}&clientToken=${record.id}`
  const post = (body) =>
    withRetry(async () => {
      const { data } = await HTTP.post(`${BASE(projectId)}?${query}`, body, { headers: await headers() })
      invalidate(projectId, 'records') // 写入成功后失效回读缓存，任务视图立即可见新日志
      return data
    }, 2)

  try {
    const data = await post(build())
    return { data, linkedTaskRecordId }
  } catch (err) {
    if (linkValue == null) throw err
    console.warn('[table] 含关联任务写入失败，降级普通写入:', err?.response?.data?.message || err?.message)
    linkValue = null
    const data = await post(build())
    return { data, linkedTaskRecordId: '' } // 关联列写入失败：无任务联动
  }
}

/** 新增日志（导出）：权限兜底后写入 */
export function addRecord(record, operatorId, projectId = '') {
  return withPermFallback(operatorId, projectId, (op) => writeRecord(record, op, projectId))
}

/** 检测「关联任务」列是否为钉钉原生关联类型（读字段定义，失败视为非关联，走文本写入） */
async function isLinkColumn(operatorId, projectId = '') {
  const b = bucketOf(projectId)
  if (b.linkColType && Date.now() < b.linkColType.expireAt) {
    return b.linkColType.type.includes('Link')
  }
  try {
    const t = getTable(projectId)
    const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
    const { data } = await HTTP.get(
      `https://api.dingtalk.com/v1.0/notable/bases/${t.baseId}/sheets/${encodeURIComponent(t.sheetId)}/fields?operatorId=${op}`,
      { headers: await headers() },
    )
    const field = (data?.value || []).find((x) => x.name === t.linkCol)
    const type = field?.type || ''
    b.linkColType = { type, expireAt: Date.now() + 5 * 60_000 }
    return type.includes('Link')
  } catch (err) {
    console.warn('[table] 读取关联列类型失败，按文本方式写入:', err?.message)
    return false
  }
}

/* ===================== 任务表关联 ===================== */

/** user列统一解析：[{name, unionId?}] → {names:[姓名], unionIds:[unionId]}（字段缺失/结构异常时返回空） */
function parseUserCol(raw) {
  if (!Array.isArray(raw)) return { names: [], unionIds: [] }
  const names = []
  const unionIds = []
  for (const m of raw) {
    if (m?.name) names.push(m.name)
    if (m?.unionId) unionIds.push(m.unionId)
  }
  return { names, unionIds }
}

/** 拉取任务表全量：[{recordId, title, owner, ownerUnionIds, memberUnionIds, status, planDate, category}]
 *  负责人/参与人（列存在时）均提取 unionId，供"我的任务"按人过滤
 *  缓存30秒 + force 强刷：钉钉表格侧的外部修改（如改负责人）30秒内自动同步，
 *  H5 下拉刷新/手动刷新传 force 立即回源（钉钉Notable API 读取本身是实时的）
 */
async function fetchTasks(operatorId, projectId = '', { force = false } = {}) {
  const t = getTable(projectId)
  if (!t.taskSheetName) return []
  const b = bucketOf(projectId)
  if (!force && b.tasks && Date.now() < b.tasks.expireAt) return b.tasks.list

  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const url = (nextToken) =>
    `https://api.dingtalk.com/v1.0/notable/bases/${t.baseId}/sheets/${encodeURIComponent(t.taskSheetName)}/records?operatorId=${op}&maxResults=100${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`

  const list = []
  let nextToken = ''
  do {
    const { data } = await withRetry(async () => HTTP.get(url(nextToken), { headers: await headers() }), 2)
    for (const row of data?.records || []) {
      const v = row.fields?.[t.taskTitleCol]
      const title = Array.isArray(v) ? v.map((x) => x?.text ?? x).join('') : v == null ? '' : String(v)
      if (!title.trim()) continue
      const { names: ownerNames, unionIds: ownerUnionIds } = parseUserCol(row.fields?.['负责人'])
      // 参与人列（协作成员）：任务表没有该列时解析为空，不影响
      const { names: memberNames, unionIds: memberUnionIds } = parseUserCol(row.fields?.['参与人'])
      const st = row.fields?.['状态']
      const status = st?.name ?? (typeof st === 'string' ? st : '')
      const planRaw = row.fields?.['计划节点']
      const catRaw = row.fields?.['任务分类']
      const category = catRaw?.name ?? (typeof catRaw === 'string' ? catRaw : '')
      list.push({
        recordId: row.id,
        title: title.trim(),
        owner: ownerNames.join('、'),
        ownerUnionIds,
        members: memberNames.join('、'),
        memberUnionIds,
        status,
        planDate: typeof planRaw === 'number' ? toPlainDate(planRaw) : '',
        category,
      })
    }
    nextToken = data?.nextToken || ''
  } while (nextToken)

  b.tasks = { list, expireAt: Date.now() + 30_000 }
  return list
}

/** 任务表全量（导出）：权限兜底后拉取；opts.force 绕过缓存强制回源钉钉 */
export function listTasks(operatorId, projectId = '', opts = {}) {
  return withPermFallback(operatorId, projectId, (op) => fetchTasks(op, projectId, opts))
}

/* ===================== 计划（任务表写入） ===================== */

const TASK_SHEET = (projectId = '') => {
  const t = getTable(projectId)
  return `https://api.dingtalk.com/v1.0/notable/bases/${t.baseId}/sheets/${encodeURIComponent(t.taskSheetName || '任务表')}`
}

/** 拉取项目成员表：姓名 + 通讯录用户unionId（写任务表负责人user列用）+ 角色 */
async function fetchMembers(operatorId, projectId = '') {
  const b = bucketOf(projectId)
  if (b.members && Date.now() < b.members.expireAt) return b.members.list
  const t = getTable(projectId)
  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const url = (nextToken) =>
    `https://api.dingtalk.com/v1.0/notable/bases/${t.baseId}/sheets/${encodeURIComponent(t.memberSheetName || '项目成员表')}/records?operatorId=${op}&maxResults=100${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`
  const list = []
  let nextToken = ''
  do {
    const { data } = await withRetry(async () => HTTP.get(url(nextToken), { headers: await headers() }), 2)
    for (const row of data?.records || []) {
      const name = toText(row.fields?.['姓名']).trim()
      const du = row.fields?.['通讯录用户']
      const unionId = Array.isArray(du) && du[0]?.unionId ? du[0].unionId : ''
      if (!name) continue
      const roleRaw = row.fields?.['角色']
      const roles = Array.isArray(roleRaw) ? roleRaw.map((r) => r?.name).filter(Boolean) : roleRaw?.name ? [roleRaw.name] : []
      list.push({ name, unionId, roles })
    }
    nextToken = data?.nextToken || ''
  } while (nextToken)
  b.members = { list, expireAt: Date.now() + 5 * 60_000 }
  return list
}

/** 项目成员表（导出）：权限兜底后拉取 */
export function listMembers(operatorId, projectId = '') {
  return withPermFallback(operatorId, projectId, (op) => fetchMembers(op, projectId))
}

async function listTaskFields(operatorId, projectId = '') {
  const b = bucketOf(projectId)
  if (b.taskFields && Date.now() < b.taskFields.expireAt) return b.taskFields.list
  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const { data } = await HTTP.get(`${TASK_SHEET(projectId)}/fields?operatorId=${op}`, { headers: await headers() })
  const list = data?.value || []
  b.taskFields = { list, expireAt: Date.now() + 5 * 60_000 }
  return list
}

/** 任务分类选项（读任务表「任务分类」单选列配置；读不到给默认集） */
export async function listTaskCategories(operatorId, projectId = '') {
  try {
    const fields = await withPermFallback(operatorId, projectId, (op) => listTaskFields(op, projectId))
    const choices = fields.find((f) => f.name === '任务分类')?.property?.choices || []
    const list = choices.map((c) => c.name).filter(Boolean)
    if (list.length) return list
  } catch (err) {
    console.warn('[table] 读取任务分类选项失败，使用默认:', err?.message)
  }
  return ['项目管理', '客户沟通', '技术研发', '前端部署', '其它']
}

/**
 * 更新任务记录：PUT 批量更新接口（钉钉Notable无单记录PUT，body内以 id 指定行，实测格式）
 * recordId 必须来自 listTasks 解析结果；fields 为要覆盖的列值
 */
async function updateTaskFields(recordId, fields, operatorId, projectId = '') {
  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const { data } = await withRetry(
    async () =>
      HTTP.put(
        `${TASK_SHEET(projectId)}/records?operatorId=${op}`,
        { records: [{ id: recordId, fields }] },
        { headers: await headers() },
      ),
    2,
  )
  return data
}

export function updateTaskStatus(recordId, status, operatorId, projectId = '') {
  return withPermFallback(operatorId, projectId, (op) =>
    updateTaskFields(recordId, { 状态: status }, op, projectId).then((r) => {
      invalidate(projectId, 'tasks') // 状态改完任务页立即可见新值
      return r
    }),
  )
}

/**
 * 计划写入任务表：{title, ownerUnionId, ownerName, planDate('YYYY-MM-DD'), category, memberUnionIds[]}
 * 状态默认「未开始」；负责人user列缺unionId时跳过该列（不阻断）
 * 参与人列（存在时）写多选用户：领导下达指令的多负责人 → 首位为负责人、其余为参与人
 * clientToken 幂等：补推重发不会在任务表产生重复行
 * 返回创建成功的任务记录ID（用于指令表↔任务表强关联；响应里取不到时回查兜底）
 */
async function writePlanRecord(plan, operatorId, clientToken, projectId) {
  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const fields = {
    任务名称: plan.title,
    状态: plan.status || '未开始',
  }
  if (plan.ownerUnionId) fields.负责人 = [{ unionId: plan.ownerUnionId }]
  if (Array.isArray(plan.memberUnionIds) && plan.memberUnionIds.length) {
    fields.参与人 = plan.memberUnionIds.filter(Boolean).map((unionId) => ({ unionId }))
  }
  if (plan.planDate) fields.计划节点 = plan.planDate
  if (plan.category) fields.任务分类 = plan.category
  const q = clientToken ? `&clientToken=${encodeURIComponent(clientToken)}` : ''
  const { data } = await withRetry(
    async () => HTTP.post(`${TASK_SHEET(projectId)}/records?operatorId=${op}${q}`, { records: [{ fields }] }, { headers: await headers() }),
    2,
  )
  invalidate(projectId, 'tasks') // 写入成功后失效任务缓存，任务页立即可见
  return { data, recordId: pickCreatedRecordId(data) }
}

/** 从新增记录响应中提取新行记录ID（不同接口版本字段结构不同，逐一兼容） */
function pickCreatedRecordId(data) {
  const tryList = (arr) => (Array.isArray(arr) && arr.length ? String(arr[0]?.id ?? arr[0]?.recordId ?? '') : '')
  return (
    tryList(data?.records) ||
    tryList(data?.value) ||
    (Array.isArray(data?.recordIds) && data.recordIds.length ? String(data.recordIds[0]) : '')
  )
}

/** 计划写入（导出）：权限兜底后写入 */
export function addPlanRecord(plan, operatorId, clientToken, projectId = '') {
  return withPermFallback(operatorId, projectId, (op) => writePlanRecord(plan, op, clientToken, projectId))
}

/** 内容匹配任务：工作内容含任务名 → 命中（取最长任务名，避免短名误中） */
export async function matchTask(content, operatorId, projectId = '') {
  if (!content) return null
  const tasks = await listTasks(operatorId, projectId)
  if (!tasks.length) return null
  const norm = (s) => String(s).replace(/[\s，,。、；;（）()]/g, '').toLowerCase()
  const c = norm(content)

  // 相似度：任务名去噪后的字符二元组(相邻两字)在内容中的覆盖率（容忍"及/与"等一字之差、语序微调）
  const bigrams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const score = (title) => {
    const t = norm(title)
    if (!t) return 0
    if (c.includes(t)) return 1 // 完整包含：满分
    const gs = bigrams(t)
    let hit = 0
    for (const g of gs) if (c.includes(g)) hit++
    return gs.size ? hit / gs.size : 0
  }

  let best = null
  let bestScore = 0
  for (const x of tasks) {
    const s = score(x.title)
    if (s > bestScore) {
      best = x
      bestScore = s
    }
  }
  // 覆盖率≥0.6 视为命中（任务名大部分内容都在日志里出现）
  if (bestScore >= 0.6) return best

  // 规则未命中 → AI 语义匹配兜底（"与周部长商议采购" ↔ "协同平台采购招标"这类同义不同词的场景）
  const aiHit = await matchTaskByAI(content, tasks)
  return aiHit || null
}

/** AI 语义匹配：把任务清单给LLM挑最相关的一项；失败/未配置/超时返回 null（不影响入库） */
async function matchTaskByAI(content, tasks) {
  try {
    const { chat } = await import('./llm.js')
    const { getAI } = await import('./settings.js')
    if (!getAI().enabled) return null

    const list = tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
    const prompt = [
      '你是工作任务匹配助手。根据一条工作日志，从任务清单中选出它最可能所属的那一项任务。',
      '要求：只在日志内容与某任务明显属于同一件工作时才选择；牵强、模糊、无明显关联时必须回复0。',
      '只回复一个数字（任务编号或0），不要任何其他内容。',
      '',
      '任务清单：',
      list,
      '',
      `工作日志：${content}`,
    ].join('\n')

    const reply = await chat(
      [
        { role: 'system', content: '你只输出一个数字，不做解释。' },
        { role: 'user', content: prompt },
      ],
      { budgetMs: 20_000 }, // 预算需容纳主模型超时(15s)+备用模型，前端已放宽提交等待
    )
    const n = parseInt(String(reply || '').replace(/\D/g, ''), 10)
    if (!Number.isInteger(n) || n < 1 || n > tasks.length) return null
    const hit = tasks[n - 1]
    console.log(`[table] AI语义匹配命中: "${content.slice(0, 20)}..." → ${hit.title}`)
    return hit
  } catch (err) {
    console.warn('[table] AI语义匹配失败（跳过，不影响入库）:', err?.message)
    return null
  }
}

/* ===================== 日志表读取（镜像/AI查询用） ===================== */

/** 全量拉取记录（分页，30秒缓存，按项目分桶），映射回业务字段 */
async function fetchAllRecords({ force = false, operatorId, projectId = '' } = {}) {
  const b = bucketOf(projectId)
  if (!force && b.records && Date.now() < b.records.expireAt) return b.records.list

  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const rows = []
  let nextToken = ''
  do {
    let query = `operatorId=${op}&maxResults=100`
    if (nextToken) query += `&nextToken=${encodeURIComponent(nextToken)}`
    const { data } = await withRetry(
      async () => HTTP.get(`${BASE(projectId)}?${query}`, { headers: await headers() }),
      2,
    )
    for (const row of data?.records || []) rows.push(rowToRecord(row.fields || {}, row))
    nextToken = data?.nextToken || ''
  } while (nextToken)

  rows.sort((a, b2) => String(b2.recordTime).localeCompare(String(a.recordTime)))
  b.records = { list: rows, expireAt: Date.now() + 30_000 }
  return rows
}

/** 全量记录（导出）：权限兜底后拉取 */
export function listAllRecords(opts = {}) {
  return withPermFallback(opts.operatorId, opts.projectId, (op) => fetchAllRecords({ ...opts, operatorId: op }))
}

/* ===================== 领导指令表 ===================== */

// 指令表列名（建表时的标准表头）
const DIR_COLS = {
  title: '任务名称',
  raisedAt: '提出日期', // 日期时间列：写毫秒时间戳
  owners: '负责人', // user多选：写 [{unionId},...]
  deadline: '办结时限', // 日期列：'YYYY-MM-DD'
  status: '状态', // 单选：未开始/进行中/已完成/已延期
  progress: '执行进展', // 文本/富文本
}

const DIRECTIVE_STATUSES = ['未开始', '进行中', '已完成', '已延期']
const DIRECTIVE_SHEET = (projectId = '') => {
  const t = getTable(projectId)
  return `https://api.dingtalk.com/v1.0/notable/bases/${t.baseId}/sheets/${encodeURIComponent(t.directiveSheetName || '领导指令表')}`
}

/** 指令行 → 业务对象 */
function rowToDirective(row) {
  const f = row.fields || {}
  const ownersRaw = f[DIR_COLS.owners]
  const owners = Array.isArray(ownersRaw) ? ownersRaw.map((m) => m?.name).filter(Boolean) : []
  const ownerUnionIds = Array.isArray(ownersRaw) ? ownersRaw.map((m) => m?.unionId).filter(Boolean) : []
  const st = f[DIR_COLS.status]
  const raisedRaw = f[DIR_COLS.raisedAt]
  return {
    recordId: row.id,
    title: toText(f[DIR_COLS.title]),
    raisedAt: typeof raisedRaw === 'number' ? fmtDateTimeStr(new Date(raisedRaw)) : toPlainDate(raisedRaw),
    owners,
    ownerUnionIds,
    deadline: toPlainDate(f[DIR_COLS.deadline]),
    status: st?.name ?? (toText(st) || '未开始'),
    progress: toText(f[DIR_COLS.progress]),
  }
}

const pad2 = (n) => String(n).padStart(2, '0')
const fmtDateTimeStr = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`

/** 指令表全量拉取（30秒缓存 + force 强刷），提出日期倒序 */
async function fetchDirectives(operatorId, projectId = '', { force = false } = {}) {
  const b = bucketOf(projectId)
  if (!force && b.directives && Date.now() < b.directives.expireAt) return b.directives.list

  const t = getTable(projectId)
  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const list = []
  let nextToken = ''
  do {
    let query = `operatorId=${op}&maxResults=100`
    if (nextToken) query += `&nextToken=${encodeURIComponent(nextToken)}`
    const { data } = await withRetry(
      async () => HTTP.get(`${DIRECTIVE_SHEET(projectId)}/records?${query}`, { headers: await headers() }),
      2,
    )
    for (const row of data?.records || []) {
      const d = rowToDirective(row)
      if (d.title.trim()) list.push(d)
    }
    nextToken = data?.nextToken || ''
  } while (nextToken)

  list.sort((a, b2) => String(b2.raisedAt).localeCompare(String(a.raisedAt)))
  b.directives = { list, expireAt: Date.now() + 30_000 }
  return list
}

/** 指令表全量（导出）：权限兜底后拉取 */
export function listDirectives(operatorId, projectId = '', opts = {}) {
  return withPermFallback(operatorId, projectId, (op) => fetchDirectives(op, projectId, opts))
}

/** 新增指令行：{title, raisedAt(ms), ownerUnionIds[], deadline, status, progress}，clientToken 幂等
 *  返回新行记录ID */
async function writeDirective(d, operatorId, clientToken, projectId) {
  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const fields = {
    [DIR_COLS.title]: d.title,
    [DIR_COLS.raisedAt]: Number(d.raisedAt) || Date.now(),
    [DIR_COLS.deadline]: d.deadline,
    [DIR_COLS.status]: DIRECTIVE_STATUSES.includes(d.status) ? d.status : '未开始',
  }
  if (Array.isArray(d.ownerUnionIds) && d.ownerUnionIds.length) {
    fields[DIR_COLS.owners] = d.ownerUnionIds.filter(Boolean).map((unionId) => ({ unionId }))
  }
  if (d.progress) fields[DIR_COLS.progress] = d.progress
  const q = clientToken ? `&clientToken=${encodeURIComponent(clientToken)}` : ''
  const { data } = await withRetry(
    async () =>
      HTTP.post(`${DIRECTIVE_SHEET(projectId)}/records?operatorId=${op}${q}`, { records: [{ fields }] }, { headers: await headers() }),
    2,
  )
  invalidate(projectId, 'directives')
  return pickCreatedRecordId(data)
}

/** 新增指令（导出）：权限兜底后写入，返回新行记录ID */
export function addDirective(d, operatorId, clientToken, projectId = '') {
  return withPermFallback(operatorId, projectId, (op) => writeDirective(d, op, clientToken, projectId))
}

/** 更新指令行字段（执行进展/状态同步用）：fields 为 {列名: 值} */
async function updateDirectiveRow(recordId, fields, operatorId, projectId = '') {
  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const { data } = await withRetry(
    async () =>
      HTTP.put(`${DIRECTIVE_SHEET(projectId)}/records?operatorId=${op}`, { records: [{ id: recordId, fields }] }, { headers: await headers() }),
    2,
  )
  invalidate(projectId, 'directives')
  return data
}

/** 更新指令（导出）：权限兜底后更新 */
export function updateDirectiveFields(recordId, fields, operatorId, projectId = '') {
  return withPermFallback(operatorId, projectId, (op) => updateDirectiveRow(recordId, fields, op, projectId))
}

export { DIRECTIVE_STATUSES, DIR_COLS, fmtDateTimeStr }
