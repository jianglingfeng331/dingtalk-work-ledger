import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuid } from 'uuid'
import { config } from '../config.js'
import * as table from './dingtalk-table.js'
import { enqueue } from './pending-push.js'
import { DATA_DIR, getTable, listProjects } from './settings.js'
import { invalidateMcpCache } from './mcp-cache.js'
import { scheduleProgressSync } from './directive.js'

/**
 * 数据存储层（门面）
 * - 表格模式：写入钉钉AI表格（唯一数据源），内存镜像加速查询，启动时全量回载
 * - 演示模式：本地文件持久化 data/records.json，重启不丢数据
 * - 两种模式镜像均落盘，作为兜底备份
 */
const RECORDS_FILE = path.join(DATA_DIR, 'records.json')

const mirror = []

/** 诊断用：镜像当前条数 */
export function mirrorCount() {
  return mirror.length
}

const pad = (n) => String(n).padStart(2, '0')
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fmtDateTime = (d) => `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`

function withinDays(dateStr, days) {
  const t = new Date(String(dateStr).replace(/-/g, '/')).getTime()
  if (Number.isNaN(t)) return false
  const diff = (Date.now() - t) / 86400000
  return diff >= 0 && diff < days
}

/** 镜像落盘（同步小文件，量级轻） */
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(mirror))
}

/** 启动时回载本地落盘数据 */
export function loadFromFile() {
  try {
    const rows = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'))
    if (Array.isArray(rows)) rows.forEach((r) => mirror.push(r))
  } catch {
    /* 首次运行无文件 */
  }
  // 多项目迁移回填：仅一个项目时，历史记录（无projectId）归属该项目，避免升级后列表变空
  const ps = listProjects()
  if (ps.length === 1 && mirror.some((r) => !r.projectId)) {
    mirror.forEach((r) => {
      if (!r.projectId) r.projectId = ps[0].id
    })
    persist()
  }
}

/** 登录拿到真实姓名后，回溯修正该用户历史记录的显示名（此前权限缺失时以“钉钉用户-xxxx”入库） */
export function fixRecorderName(userId, realName) {
  if (!userId || !realName || realName.startsWith('钉钉用户-')) return 0
  let n = 0
  mirror.forEach((r) => {
    if (r.userId === userId && r.recorder !== realName) {
      r.recorder = realName
      n++
    }
  })
  if (n) persist()
  return n
}

/** 新增一条工作记录：结构化字段由 parser 生成，此处补全 id/人/时间
 * taskId：用户在页面显式选择的关联任务记录ID（空则由表格层智能匹配）
 * 表格推送失败不丢数据：照常写本地镜像（标记待补推）并返回半成功状态，由补推队列自动重推 */
export async function addRecord({ user, rawContent, parsed, projectId = '', taskId = '' }) {
  const record = {
    id: uuid(),
    projectId,
    userId: user.userId,
    unionId: user.unionId || '',
    recorder: user.name,
    recordTime: fmtDateTime(new Date()),
    rawContent,
    taskId,
    ...parsed,
  }

  let pendingSync = false
  let linkedTaskId = ''
  if (getTable(projectId).enabled) {
    try {
      const written = await table.addRecord(record, user.unionId, projectId)
      linkedTaskId = written?.linkedTaskRecordId || ''
    } catch (err) {
      pendingSync = true
      record.pendingSync = true
      enqueue({ type: 'work', clientToken: record.id, payload: record })
      console.warn(`[store] 表格推送失败，已入补推队列(${record.id.slice(0, 8)}):`, err?.response?.data?.message || err?.message)
    }
  }

  mirror.unshift(record)
  persist()
  invalidateMcpCache() // 数据变更即失效 MCP 缓存，保证后续查询新鲜度
  // 日志关联到领导指令任务时：延迟归纳当日日志 → 同步指令「执行进展」（fire-and-forget，不阻断响应）
  if (linkedTaskId) scheduleProgressSync(projectId, linkedTaskId)
  return { ...record, pendingSync, linkedTaskId }
}

/** 补推成功后：镜像清除待补推标记 */
export function fixMirrorPushed(id) {
  const row = mirror.find((r) => r.id === id)
  if (row && row.pendingSync) {
    delete row.pendingSync
    persist()
  }
}

/** 查询记录：默认仅本人；管理员可传 team=true 查全员；按当前项目过滤
 * 本人判定：userId 相同，或成员列 unionId 相同（表格回载的记录只有unionId，无userId） */
export async function listRecords({ user, scope = 'all', team = false, projectId = '' }) {
  const canTeam = team && user.isAdmin
  const isMine = (r) => r.userId === user.userId || (user.unionId && r.unionId === user.unionId)
  let list = mirror.filter((r) => (r.projectId || '') === projectId)
  list = canTeam ? list : list.filter(isMine)

  if (scope === 'today') list = list.filter((r) => r.taskDate === fmtDate(new Date()))
  else if (scope === 'week') list = list.filter((r) => withinDays(r.taskDate, 7))
  else if (scope === 'undone') list = list.filter((r) => r.progress !== '已完成')

  return list
}

/** 全量数据（阶段四 AI 查询上下文用）：可带项目过滤 */
export async function listAllRecords(projectId) {
  if (projectId === undefined) return mirror
  return mirror.filter((r) => (r.projectId || '') === (projectId || ''))
}

/** 表格模式启动时：遍历所有项目，全量回载钉钉AI表格数据到镜像（每条带projectId） */
export async function initFromTable() {
  for (const p of listProjects()) {
    if (!p.baseId) continue
    try {
      const t = getTable(p.id)
      if (!t.enabled) continue
      const rows = await table.listAllRecords({ force: true, projectId: p.id })
      // 清该项目旧镜像再灌入（其它项目不受影响）
      for (let i = mirror.length - 1; i >= 0; i--) if ((mirror[i].projectId || '') === p.id) mirror.splice(i, 1)
      rows.forEach((r) => mirror.push({ ...r, projectId: p.id }))
      console.log(`[store] 项目「${p.name}」回载 ${rows.length} 条工作记录`)
    } catch (err) {
      console.warn(`[store] 项目「${p.name}」表格回载失败:`, err?.message)
    }
  }
  persist()
}

/** 演示模式：首次启动预置示例数据，便于联调体验 */
export function seedDemoData() {
  if (config.dingtalkEnabled || mirror.length) return
  const now = Date.now()
  const day = 86400000
  const demo = [
    {
      rawContent: '上午和小王对齐了接口方案，下午完成了登录模块的开发，整体进度符合预期',
      title: '和小王对齐了接口方案',
      progress: '已完成',
      taskDate: fmtDate(new Date()),
      tags: ['开发', '对接'],
      offsetMs: -3 * 3600000,
    },
    {
      rawContent: '跟进测试同学反馈的支付流程Bug，正在修复中，预计明天提测',
      title: '跟进支付流程Bug修复',
      progress: '进行中',
      taskDate: fmtDate(new Date(now - day)),
      tags: ['测试', '修复'],
      offsetMs: -26 * 3600000,
    },
    {
      rawContent: '参加了本周项目周会，同步了里程碑计划，会后整理了会议文档',
      title: '参加本周项目周会',
      progress: '已完成',
      taskDate: fmtDate(new Date(now - 2 * day)),
      tags: ['会议', '文档'],
      offsetMs: -50 * 3600000,
    },
  ]
  demo.forEach((d) => {
    mirror.push({
      id: uuid(),
      userId: 'local-guest',
      recorder: '演示用户',
      recordTime: fmtDateTime(new Date(now + d.offsetMs)),
      rawContent: d.rawContent,
      title: d.title,
      progress: d.progress,
      taskDate: d.taskDate,
      tags: d.tags,
    })
  })
  persist()
}
