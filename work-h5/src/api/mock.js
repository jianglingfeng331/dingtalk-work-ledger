/**
 * 本地演示数据层：阶段一后端未就绪时自动降级使用（localStorage 存储）。
 * 数据字段与钉钉AI表格表头严格对齐：
 * 唯一ID / 记录人 / 记录时间 / 原始工作内容 / 结构化任务标题 / 任务进度 / 任务日期 / 任务标签
 * 阶段二联调后，api 层请求成功即自动走真实接口，本文件无需删除。
 */
import { fmtDate, fmtDateTime, withinDays } from '../utils/format'

const RECORDS_KEY = 'work_records'
const SEED_KEY = 'work_seeded'
const TOKEN_KEY = 'work_token'
const USER_KEY = 'work_user'

const uid = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

function getRecords() {
  try {
    return JSON.parse(localStorage.getItem(RECORDS_KEY) || '[]')
  } catch {
    return []
  }
}

function saveRecords(list) {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(list))
}

function localUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null') || { name: '演示用户' }
  } catch {
    return { name: '演示用户' }
  }
}

/* ---------- 轻量规则解析（模拟后端阶段三的结构化解析） ---------- */
const TAG_KEYWORDS = ['开发', '测试', '对接', '复盘', '会议', '文档', '设计', '部署', '沟通', '修复', '联调', '需求']
const DONE_RE = /完成|上线|搞定|结束|已处理|已发布/
const DOING_RE = /进行|推进|开发中|处理中|跟进|开始|联调/

function parseTask(raw) {
  const text = (raw || '').trim()
  const firstClause =
    text
      .split(/[，。；;、\n]/)
      .map((s) => s.trim())
      .filter(Boolean)[0] || '未命名任务'

  let progress = '未开始'
  if (DOING_RE.test(text)) progress = '进行中'
  if (DONE_RE.test(text)) progress = '已完成'

  const now = new Date()
  let taskDate = fmtDate(now)
  if (/明天/.test(text)) taskDate = fmtDate(new Date(now.getTime() + 86400000))
  else if (/昨天/.test(text)) taskDate = fmtDate(new Date(now.getTime() - 86400000))

  const tags = TAG_KEYWORDS.filter((t) => text.includes(t))
  return { title: firstClause.slice(0, 30), progress, taskDate, tags }
}

/* ---------- 首次运行种子数据，便于演示 ---------- */
function ensureSeed() {
  if (localStorage.getItem(SEED_KEY)) return
  localStorage.setItem(SEED_KEY, '1')
  if (getRecords().length) return

  const now = Date.now()
  const day = 86400000
  saveRecords([
    {
      id: uid(),
      recorder: '演示用户',
      recordTime: fmtDateTime(new Date(now - 3600000)),
      rawContent: '上午和小王对齐了接口方案，下午完成了登录模块的开发，整体进度符合预期',
      title: '上午和小王对齐了接口方案',
      progress: '已完成',
      taskDate: fmtDate(new Date()),
      tags: ['开发', '对接'],
    },
    {
      id: uid(),
      recorder: '演示用户',
      recordTime: fmtDateTime(new Date(now - day * 3600000)),
      rawContent: '跟进测试同学反馈的支付流程Bug，正在修复中，预计明天提测',
      title: '跟进支付流程Bug修复',
      progress: '进行中',
      taskDate: fmtDate(new Date(now - day)),
      tags: ['测试', '修复'],
    },
    {
      id: uid(),
      recorder: '演示用户',
      recordTime: fmtDateTime(new Date(now - day * 26 * 3600000)),
      rawContent: '参加了本周项目周会，同步了里程碑计划，会后整理了会议文档',
      title: '参加本周项目周会',
      progress: '已完成',
      taskDate: fmtDate(new Date(now - day * 2)),
      tags: ['会议', '文档'],
    },
  ])
}

/* ---------- Mock API ---------- */
export function mockLogin() {
  const token = 'mock-token-' + uid()
  localStorage.setItem(TOKEN_KEY, token)
  // 兜底用户保留管理员身份：确保降级后仍能进设置页查看诊断
  return { userId: 'local-guest', name: '钉钉用户', isAdmin: true, token }
}

export function mockSubmitWork(content, user) {
  ensureSeed()
  const parsed = parseTask(content)
  const record = {
    id: uid(),
    recorder: user?.name || localUser().name,
    recordTime: fmtDateTime(),
    rawContent: content.trim(),
    ...parsed,
  }
  const list = getRecords()
  list.unshift(record)
  saveRecords(list)
  return record
}

export function mockGetWorkList(params = {}) {
  ensureSeed()
  const { scope = 'all' } = params
  let list = getRecords()
  if (scope === 'today') list = list.filter((r) => r.taskDate === fmtDate())
  else if (scope === 'week') list = list.filter((r) => withinDays(r.taskDate, 7))
  else if (scope === 'undone') list = list.filter((r) => r.progress !== '已完成')
  return list
}
