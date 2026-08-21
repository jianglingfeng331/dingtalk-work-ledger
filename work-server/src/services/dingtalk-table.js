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
    buckets.set(key, { records: null, tasks: null, members: null, taskFields: null, linkColType: null })
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
export async function addRecord(record, operatorId, projectId = '') {
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
  try {
    // 标题+原始内容合并参与匹配（短标题信息量不足，易漏配）
    const hit = await matchTask(`${record.title || ''}。${record.rawContent || ''}`, operatorId, projectId)
    if (hit) {
      isNativeLink = await isLinkColumn(operatorId, projectId)
      linkValue = isNativeLink ? { linkedRecordIds: [hit.recordId] } : hit.title
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
    return await post(build())
  } catch (err) {
    if (linkValue == null) throw err
    console.warn('[table] 含关联任务写入失败，降级普通写入:', err?.response?.data?.message || err?.message)
    linkValue = null
    return await post(build())
  }
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

/** 拉取任务表全量：[{recordId, title, owner, status, planDate}]（列名按任务表默认表头，缺失时置空） */
export async function listTasks(operatorId, projectId = '') {
  const t = getTable(projectId)
  if (!t.taskSheetName) return []
  const b = bucketOf(projectId)
  if (b.tasks && Date.now() < b.tasks.expireAt) return b.tasks.list

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
      const ownerRaw = row.fields?.['负责人']
      const owner = Array.isArray(ownerRaw)
        ? ownerRaw.map((m) => m?.name).filter(Boolean).join('、')
        : ''
      const st = row.fields?.['状态']
      const status = st?.name ?? (typeof st === 'string' ? st : '')
      const planRaw = row.fields?.['计划节点']
      list.push({
        recordId: row.id,
        title: title.trim(),
        owner,
        status,
        planDate: typeof planRaw === 'number' ? toPlainDate(planRaw) : '',
      })
    }
    nextToken = data?.nextToken || ''
  } while (nextToken)

  b.tasks = { list, expireAt: Date.now() + 5 * 60_000 }
  return list
}

/* ===================== 计划（任务表写入） ===================== */

const TASK_SHEET = (projectId = '') => {
  const t = getTable(projectId)
  return `https://api.dingtalk.com/v1.0/notable/bases/${t.baseId}/sheets/${encodeURIComponent(t.taskSheetName || '任务表')}`
}

/** 拉取项目成员表：姓名 + 通讯录用户unionId（写任务表负责人user列用）+ 角色 */
export async function listMembers(operatorId, projectId = '') {
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
    const fields = await listTaskFields(operatorId, projectId)
    const choices = fields.find((f) => f.name === '任务分类')?.property?.choices || []
    const list = choices.map((c) => c.name).filter(Boolean)
    if (list.length) return list
  } catch (err) {
    console.warn('[table] 读取任务分类选项失败，使用默认:', err?.message)
  }
  return ['项目管理', '客户沟通', '技术研发', '前端部署', '其它']
}

/**
 * 计划写入任务表：{title, ownerUnionId, ownerName, planDate('YYYY-MM-DD'), category}
 * 状态默认「未开始」；负责人user列缺unionId时跳过该列（不阻断）
 * clientToken 幂等：补推重发不会在任务表产生重复行
 */
export async function addPlanRecord(plan, operatorId, clientToken, projectId = '') {
  const op = encodeURIComponent(requireOperatorId(operatorId, projectId))
  const fields = {
    任务名称: plan.title,
    状态: plan.status || '未开始',
  }
  if (plan.ownerUnionId) fields.负责人 = [{ unionId: plan.ownerUnionId }]
  if (plan.planDate) fields.计划节点 = plan.planDate
  if (plan.category) fields.任务分类 = plan.category
  const q = clientToken ? `&clientToken=${encodeURIComponent(clientToken)}` : ''
  const { data } = await withRetry(
    async () => HTTP.post(`${TASK_SHEET(projectId)}/records?operatorId=${op}${q}`, { records: [{ fields }] }, { headers: await headers() }),
    2,
  )
  invalidate(projectId, 'tasks') // 写入成功后失效任务缓存，任务页立即可见
  return data
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
export async function listAllRecords({ force = false, operatorId, projectId = '' } = {}) {
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
