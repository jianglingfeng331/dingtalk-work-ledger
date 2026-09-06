import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR, getTable, listProjects } from './settings.js'
import * as table from './dingtalk-table.js'
import { DIRECTIVE_STATUSES } from './dingtalk-table.js'

/**
 * 领导指令服务：指令表 ↔ 任务表 强关联 + 双向数据联动
 * - 下达指令：一条指令同时写「领导指令表」与「任务表」，以唯一记录ID建立映射（本地持久化）
 * - 日志联动：关联任务有新日志时，归纳当日全部日志 → 更新指令「执行进展」
 * - 状态联动：指令「状态」始终跟随任务状态（任务为事实源），逾期未完自动置「已延期」
 */

const LINK_FILE = path.join(DATA_DIR, 'directive-links.json')

/** taskRecordId → {projectId, directiveRecordId, title, createdAt} */
let links = {}

const pad2 = (n) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function persistLinks() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(LINK_FILE, JSON.stringify(links, null, 2))
}

function loadLinks() {
  try {
    links = JSON.parse(fs.readFileSync(LINK_FILE, 'utf8'))
    if (!links || typeof links !== 'object' || Array.isArray(links)) links = {}
  } catch {
    links = {}
  }
}
loadLinks()

/* ===================== 纯函数（单测覆盖） ===================== */

/**
 * 任务状态 → 指令状态映射（任务为事实源）
 * 逾期规则：任务未完成且办结时限 < 今天 → 已延期；任务完成后不再判逾期
 */
export function mapTaskStatusToDirective(taskStatus, deadline, now = new Date()) {
  const status = DIRECTIVE_STATUSES.includes(taskStatus) ? taskStatus : taskStatus ? '进行中' : '未开始'
  if (status !== '已完成' && deadline && deadline < fmtDay(now)) return '已延期'
  return status
}

const fmtDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 指令提交入参校验：任务名称与办结时限必填，返回错误文案（空串=通过） */
export function validateDirectiveInput({ title, deadline, owners = [] }) {
  if (!title || !String(title).trim()) return '任务名称不能为空'
  if (String(title).trim().length > 50) return '任务名称请控制在50字以内'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deadline || ''))) return '请选择办结时限'
  if (!Array.isArray(owners) || !owners.length) return '请至少选择一位负责人'
  return ''
}

/** 无 AI 时的进展兜底归纳：当日日志要点拼接（按人分条，截断防爆字段） */
export function fallbackSummary(logs) {
  const byPerson = new Map()
  for (const l of logs) {
    const key = l.recorder || '成员'
    const arr = byPerson.get(key) || []
    arr.push(String(l.rawContent || l.title || '').trim())
    byPerson.set(key, arr)
  }
  const lines = [...byPerson.entries()].map(([name, arr]) => `${name}：${arr.join('；').slice(0, 120)}`)
  return lines.join('\n').slice(0, 500)
}

/** 进展归纳 Prompt（LLM 把当日多条日志归纳成一段进展综述） */
export function buildProgressPrompt(directiveTitle, logs) {
  const logText = logs
    .map((l) => `- ${l.recorder}：${String(l.rawContent || l.title || '').trim()}（${l.progress || ''}${l.hours ? `，${l.hours}小时` : ''}）`)
    .join('\n')
  return [
    '你是工作进展归纳助手。领导给团队下达了一项指令，负责人提交了当日工作日志，请把日志归纳为一段执行进展综述。',
    '要求：突出与指令相关的实际进展、关键结论、遗留问题；不超过120字；只输出综述正文，不要标题、不要列表、不要解释。',
    '',
    `领导指令：${directiveTitle}`,
    '当日工作日志：',
    logText,
  ].join('\n')
}

/**
 * 指令 AI 解析结果归一化（纯函数，单测覆盖）
 * - owners：只保留成员表里存在的人名并去重（LLM 可能编造人名）
 * - status：限四态枚举，非法回落「未开始」
 * - deadline：YYYY-MM-DD 校验
 * - title：去空白、限50字（与指令表口径一致）
 */
export function normalizeParsedDirective(raw, memberNames = [], fallbackTitle = '') {
  const j = raw && typeof raw === 'object' ? raw : {}
  const names = Array.isArray(memberNames) ? memberNames : []
  const ownersRaw = Array.isArray(j.owners) ? j.owners : []
  const trimmed = ownersRaw.map((n) => String(n || '').trim())
  const owners = [...new Set(trimmed.filter((n) => n && names.includes(n)))]
  const title = String(j.title || '').trim().slice(0, 50) || String(fallbackTitle || '').trim().slice(0, 50)
  return {
    title,
    owners,
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(j.deadline || '')) ? String(j.deadline) : '',
    status: DIRECTIVE_STATUSES.includes(j.status) ? j.status : '未开始',
  }
}

/* ===================== 指令创建（写两表 + 建立关联） ===================== */

/**
 * 下达指令（领导/管理员）：写领导指令表 + 自动在任务表创建关联任务
 * @param {object} p {user, projectId, title, ownerNames[], deadline, status?, progress?}
 * @returns {Promise<{directiveRecordId, taskRecordId, taskPendingSync}>}
 */
export async function createDirective({ user, projectId, title, ownerNames, deadline, status = '未开始', progress = '' }) {
  const bad = validateDirectiveInput({ title, deadline, owners: ownerNames })
  if (bad) throw new Error(bad)

  const members = await table.listMembers(user.unionId, projectId).catch(() => [])
  const owners = (ownerNames || [])
    .map((name) => members.find((m) => m.name === name))
    .filter(Boolean)
  if (!owners.length) throw new Error('负责人不在项目成员表中，请重新选择')

  const cleanTitle = String(title).trim()
  const now = Date.now()
  const op = user.unionId || ''

  // 1) 先写领导指令表（主记录；失败直接报错，用户重试，clientToken 幂等防重）
  // 注意：钉钉 clientToken 要求标准 UUID v4，非 UUID 会报 400 Invalid client token
  const clientToken = crypto.randomUUID()
  const directiveRecordId = await table.addDirective(
    {
      title: cleanTitle,
      raisedAt: now,
      ownerUnionIds: owners.map((o) => o.unionId).filter(Boolean),
      deadline,
      status: DIRECTIVE_STATUSES.includes(status) ? status : '未开始',
      progress: String(progress || '').trim(),
    },
    op,
    clientToken,
    projectId,
  )

  // 2) 任务表自动创建关联任务：首位负责人=负责人，其余=参与人，办结时限=计划节点
  const plan = {
    title: cleanTitle,
    ownerUnionId: owners[0].unionId || '',
    ownerName: owners[0].name,
    memberUnionIds: owners.slice(1).map((o) => o.unionId).filter(Boolean),
    planDate: deadline,
    status: '未开始',
    projectId,
  }
  let taskRecordId = ''
  let taskPendingSync = false
  try {
    const created = await table.addPlanRecord(plan, op, crypto.randomUUID(), projectId)
    taskRecordId = created?.recordId || ''
    if (!taskRecordId) {
      // 响应取不到记录ID：按标题+时限回查（新增行标题唯一性足够日常使用）
      const tasks = await table.listTasks(op, projectId, { force: true })
      taskRecordId = tasks.find((t) => t.title === cleanTitle && t.planDate === deadline)?.recordId || ''
    }
  } catch (err) {
    taskPendingSync = true
    console.warn('[directive] 任务表创建失败（指令已记录，任务待同步）:', err?.response?.data?.message || err?.message)
  }

  // 3) 建立强关联映射（两行都创建成功才落映射；任务待同步的后续由 reconcile 补链）
  if (taskRecordId) {
    links[taskRecordId] = { projectId, directiveRecordId, title: cleanTitle, createdAt: now }
    persistLinks()
  }

  console.log(
    `[directive] ${user.name} 下达指令「${cleanTitle}」→ 指令${directiveRecordId ? '✓' : '?'} 任务${taskRecordId || '待同步'}，负责人${owners.map((o) => o.name).join('、')}，时限${deadline}`,
  )
  return { directiveRecordId, taskRecordId, taskPendingSync }
}

/** 按任务记录ID查关联的指令记录ID（无关联返回空串） */
export function directiveIdOfTask(taskRecordId) {
  return links[taskRecordId]?.directiveRecordId || ''
}

/** 全部映射（诊断/AI上下文用） */
export function allLinks() {
  return structuredClone(links)
}

/* ===================== 日志 → 执行进展 联动 ===================== */

const pendingTimers = new Map() // taskRecordId → setTimeout（合并短时间内的多条日志，归纳一次）
const SYNC_DELAY_MS = 15_000

/** 日志提交后触发：任务有关联指令时，延迟归纳当日日志 → 更新「执行进展」（fire-and-forget） */
export function scheduleProgressSync(projectId, taskRecordId) {
  if (!taskRecordId || !links[taskRecordId]) return
  if (pendingTimers.has(taskRecordId)) return // 已有排队：同一轮归纳会带上新日志
  const timer = setTimeout(() => {
    pendingTimers.delete(taskRecordId)
    syncDirectiveProgress(projectId, taskRecordId).catch((err) =>
      console.warn('[directive] 进展同步失败:', err?.message),
    )
  }, SYNC_DELAY_MS)
  pendingTimers.set(taskRecordId, timer)
}

/** 归纳指定任务当日全部日志 → 写入指令「执行进展」；无当日日志不动（保留历史综述） */
export async function syncDirectiveProgress(projectId, taskRecordId, { chat: chatFn } = {}) {
  const link = links[taskRecordId]
  if (!link) return { skipped: true, reason: 'no-link' }

  const [directives, logs] = await Promise.all([
    table.listDirectives('', projectId, { force: true }),
    table.listAllRecords({ projectId }),
  ])
  const directive = directives.find((d) => d.recordId === link.directiveRecordId)
  if (!directive) return { skipped: true, reason: 'directive-gone' }

  const day = today()
  const todayLogs = (logs || []).filter(
    (l) => (l.linkTaskRecordIds || []).includes(taskRecordId) && l.taskDate === day,
  )
  if (!todayLogs.length) return { skipped: true, reason: 'no-logs-today' }

  let summary = ''
  try {
    const doChat = chatFn || (await import('./llm.js')).chat
    const { getAI } = await import('./settings.js')
    if (getAI().enabled) {
      const reply = await doChat(
        [
          { role: 'system', content: '你只输出归纳后的进展综述正文。' },
          { role: 'user', content: buildProgressPrompt(directive.title, todayLogs) },
        ],
        { budgetMs: 25_000 },
      )
      if (reply?.trim()) summary = reply.trim()
    }
  } catch (err) {
    console.warn('[directive] AI归纳失败，降级拼接:', err?.message)
  }
  if (!summary) summary = fallbackSummary(todayLogs)

  const text = `[${day}] ${summary}`.slice(0, 600)
  await table.updateDirectiveFields(link.directiveRecordId, { 执行进展: text }, '', projectId)
  console.log(`[directive] 进展已同步「${directive.title}」: ${text.slice(0, 60)}...`)
  return { synced: true, directiveRecordId: link.directiveRecordId, text }
}

/* ===================== 状态联动（任务 → 指令，任务为事实源） ===================== */

/** 任务状态变更后触发：同步对应指令状态（含逾期判定） */
export async function syncDirectiveStatus(projectId, taskRecordId, taskStatus, taskPlanDate) {
  const link = links[taskRecordId]
  if (!link) return { skipped: true }
  const status = mapTaskStatusToDirective(taskStatus, taskPlanDate)
  await table.updateDirectiveFields(link.directiveRecordId, { 状态: status }, '', projectId)
  return { synced: true, status }
}

/**
 * 对账：全项目扫描指令↔任务，修正状态不一致（含指令表手动改状态、任务表直接改状态的外部变更）
 * 任务侧被删/找不到 → 指令状态按办结时限兜底（逾期=已延期，否则维持）
 */
export async function reconcileDirectives() {
  let fixed = 0
  for (const p of listProjects()) {
    const t = getTable(p.id)
    if (!t.enabled) continue
    try {
      const [directives, tasks] = await Promise.all([
        table.listDirectives('', p.id, { force: false }),
        table.listTasks('', p.id),
      ])
      const byDirective = new Map(
        Object.entries(links).map(([taskId, l]) => [l.directiveRecordId, { taskId, ...l }]),
      )
      for (const d of directives) {
        const link = byDirective.get(d.recordId)
        let want
        if (link) {
          const task = tasks.find((x) => x.recordId === link.taskId)
          want = task
            ? mapTaskStatusToDirective(task.status, task.planDate || d.deadline)
            : mapTaskStatusToDirective('', d.deadline)
        } else {
          // 无映射（表侧手工建的指令行）：按同名任务对齐，找不到按时限兜底
          const task = tasks.find((x) => x.title === d.title)
          want = task
            ? mapTaskStatusToDirective(task.status, task.planDate || d.deadline)
            : mapTaskStatusToDirective(d.status === '已完成' ? '已完成' : '', d.deadline)
          if (task) {
            links[task.recordId] = { projectId: p.id, directiveRecordId: d.recordId, title: d.title, createdAt: Date.now() }
            persistLinks()
          }
        }
        if (want && want !== d.status) {
          await table.updateDirectiveFields(d.recordId, { 状态: want }, '', p.id)
          fixed++
        }
      }
    } catch (err) {
      console.warn(`[directive] 项目「${p.name}」对账失败:`, err?.message)
    }
  }
  return { fixed }
}

/** 定时对账（60s一轮）：保证指令状态与任务表「实时」一致 */
export function startReconcileScheduler() {
  const timer = setInterval(() => {
    reconcileDirectives().catch(() => {})
  }, 60_000)
  timer.unref?.()
  return timer
}
