import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

/**
 * 动态配置服务：运行时可调、文件持久化（data/settings.json）、改完即生效
 * 未配置过时自动以环境变量播种（QWEN_API_KEY / DINGTALK_TABLE_* / ADMIN_USERIDS）
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 测试可通过 WORK_SERVER_DATA_DIR 指向临时目录，避免污染真实配置
export const DATA_DIR = process.env.WORK_SERVER_DATA_DIR
  ? path.resolve(process.env.WORK_SERVER_DATA_DIR)
  : path.resolve(__dirname, '../../data')
const FILE = path.join(DATA_DIR, 'settings.json')

const DEFAULTS = {
  // 任务标签库（自然语言解析的识别词库）
  tags: ['开发', '测试', '对接', '复盘', '会议', '文档', '设计', '部署', '沟通', '修复', '联调', '需求'],
  // AI 查询页快捷提问
  suggestions: ['本周我完成了哪些任务？', '我有哪些未完成的任务？', '团队本周工作汇总'],
  // 管理员 userid 列表（可查看全员数据）
  adminUserIds: [],
  // 重复提交拦截窗口（秒）
  dedupWindowSec: 60,
  // LLM 配置（全局共性，管理员设置页统一维护，各用户共享）
  ai: {
    enabled: false,
    provider: 'zhipu',
    apiKey: '',
    model: 'glm-4.7-flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  // 多项目：每个项目一个AI表格（baseId+表名），成员以该项目「项目成员表」为准
  // 兼容迁移：旧单表 table 配置首启自动转为 projects[0]
  projects: [],
  // 旧单表配置（保留仅作迁移源与回退兜底，不再直接使用）
  table: {
    baseId: '',
    sheetId: '工作日志表',
    operatorUnionId: '',
    taskSheetName: '任务表',
    taskTitleCol: '任务名称',
    linkCol: '关联任务',
  },
  // 语音识别配置（全局共性）：讯飞语音听写 WebAPI（传统引擎，免费额度每日500次）
  asr: { appId: '', apiKey: '', apiSecret: '' },
  // 桌面版（秒建功）登录令牌：管理员在设置页生成，桌面端凭此令牌换取正式会话
  // identity 绑定生成者（管理员）的 userId/name/unionId，登录后即以该身份工作
  desktop: { token: '', userId: '', name: '', unionId: '', createdAt: 0 },
}

/** 旧单表配置 → projects[0] 一次性迁移（已有 projects 则跳过） */
function migrateTableToProjects(s) {
  if ((s.projects || []).length || !s.table?.baseId) return s
  s.projects = [
    {
      id: 'p_chengtou',
      name: '城投AI协同',
      baseId: s.table.baseId,
      sheetId: s.table.sheetId || '工作日志表',
      taskSheetName: s.table.taskSheetName || '任务表',
      taskTitleCol: s.table.taskTitleCol || '任务名称',
      linkCol: s.table.linkCol || '关联任务',
      memberSheetName: '项目成员表',
      directiveSheetName: '领导指令表',
      operatorUnionId: s.table.operatorUnionId || '',
      createdAt: Date.now(),
    },
  ]
  return s
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (Array.isArray(base)) return Array.isArray(patch) ? [...patch] : out
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v
  }
  return out
}

function load() {
  try {
    return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')))
  } catch {
    // 首次运行：以环境变量播种后落盘，后续以文件为准（可在设置页动态修改）
    const seeded = structuredClone(DEFAULTS)
    seeded.ai.apiKey = process.env.QWEN_API_KEY || ''
    seeded.ai.enabled = Boolean(process.env.QWEN_API_KEY)
    seeded.table.baseId = process.env.DINGTALK_TABLE_BASE_ID || ''
    seeded.table.sheetId = process.env.DINGTALK_TABLE_SHEET_ID || ''
    seeded.table.operatorUnionId = process.env.DINGTALK_TABLE_OPERATOR_ID || ''
    seeded.table.taskSheetName = process.env.DINGTALK_TASK_SHEET_NAME || ''
    seeded.table.taskTitleCol = process.env.DINGTALK_TASK_TITLE_COL || '任务名称'
    seeded.table.linkCol = process.env.DINGTALK_LINK_COL || '关联任务'
    seeded.asr.appId = process.env.XF_APP_ID || ''
    seeded.asr.apiKey = process.env.XF_API_KEY || ''
    seeded.asr.apiSecret = process.env.XF_API_SECRET || ''
    seeded.adminUserIds = (process.env.ADMIN_USERIDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return seeded
  }
}

let state = load()
migrateTableToProjects(state)
persist()

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2))
}

/** 读取当前配置 */
export function get() {
  return structuredClone(state)
}

/** 更新配置（浅层按段合并，tags等数组整体替换），立即持久化并生效 */
export function update(patch) {
  state = deepMerge(state, patch)
  persist()
  return get()
}

/** 管理员判定：演示模式本地用户恒为管理员；正式模式访客（source=local）为普通用户 */
export function isAdmin(userId, source = '') {
  if (source === 'local' && !config.dingtalkEnabled) return true
  return state.adminUserIds.includes(userId)
}

/** LLM 提供商预设 */
export const AI_PROVIDERS = {
  zhipu: {
    label: '智谱GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    // 前两个为免费模型（官方免费额度），其余为付费高性能款
    models: ['glm-4.7-flash', 'glm-4-flash-250414', 'glm-4-air', 'glm-4-plus'],
    keyUrl: 'https://open.bigmodel.cn',
  },
  qwen: {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    keyUrl: 'https://dashscope.console.aliyun.com',
  },
}

/** LLM 生效配置（apiKey 兜底取环境变量；模型归属校正：旧模型属于其他提供商时回落默认） */
export function getAI() {
  const ai = state.ai
  const preset = AI_PROVIDERS[ai.provider] || AI_PROVIDERS.zhipu
  const apiKey = ai.apiKey || process.env.QWEN_API_KEY || process.env.AI_API_KEY || ''
  const belongsToOther = Object.entries(AI_PROVIDERS).some(
    ([key, p]) => key !== (ai.provider || 'zhipu') && p.models.includes(ai.model),
  )
  const model = belongsToOther ? preset.model : ai.model || preset.model
  const baseUrl = ai.baseUrl || preset.baseUrl
  return { ...ai, model, baseUrl, apiKey, enabled: ai.enabled && Boolean(apiKey) }
}

/** 表格生效配置（需钉钉凭据齐备）：按项目取，未指定取第一个项目 */
export function getTable(projectId) {
  const ps = state.projects || []
  const p = (projectId && ps.find((x) => x.id === projectId)) || ps[0] || {}
  return {
    ...p,
    taskSheetName: p.taskSheetName || '任务表',
    taskTitleCol: p.taskTitleCol || '任务名称',
    linkCol: p.linkCol || '关联任务',
    memberSheetName: p.memberSheetName || '项目成员表',
    directiveSheetName: p.directiveSheetName || '领导指令表',
    sheetId: p.sheetId || '工作日志表',
    enabled: config.dingtalkEnabled && Boolean(p.baseId && (p.sheetId || '工作日志表')),
  }
}

/** 按 ID 取项目原始配置（不存在返回 null） */
export function getProject(projectId) {
  const p = (state.projects || []).find((x) => x.id === projectId)
  return p ? structuredClone(p) : null
}

/**
 * 领导角色判定：项目 leaders 配置命中即真（unionId 优先精确匹配，userId 兜底）
 * user 为 H5/会话用户对象（含 userId / unionId）；管理员不自动视为领导（两个独立权限维度）
 */
export function isLeader(user, projectId) {
  if (!user) return false
  const p = (state.projects || []).find((x) => x.id === (projectId || ''))
  const leaders = Array.isArray(p?.leaders) ? p.leaders : []
  const uid = user.unionId || ''
  const userId = user.userId || ''
  return leaders.some((l) => (uid && l?.unionId === uid) || (userId && l?.userId === userId))
}

/* ===================== 项目管理（管理员） ===================== */

export function listProjects() {
  return structuredClone(state.projects || [])
}

/** 文本归一：小写、去空白与常见中英文标点（项目名/别名匹配用，容忍口语叫法差异） */
const normText = (s) => String(s || '').toLowerCase().replace(/[\s·．.。,，、;；:：!！?？\-—_/\\()（）【】\[\]]/g, '')

/**
 * 从自然语言文本中识别项目：包含项目名或任一别名即命中（城投ai项目/ai协同项目→城投AI协同）
 * 供 MCP skill 问题路由与 ?projectId= 别名参数使用；未命中返回 null
 */
export function matchProjectByText(text) {
  const t = normText(text)
  if (!t) return null
  for (const p of state.projects || []) {
    const names = [p.name, ...(Array.isArray(p.aliases) ? p.aliases : [])]
    if (names.some((n) => normText(n) && t.includes(normText(n)))) return structuredClone(p)
  }
  return null
}

/** 新建/更新项目：带 id 更新，无 id 新建；AI表格链接自动解析 baseId
 *  待审核项目（status='pending' 且走自动建表）允许暂无 baseId，审批通过时由路由补建 */
export function saveProject(input) {
  const p = { ...input }
  // 支持直接粘贴钉钉文档链接：alidocs.dingtalk.com/i/nodes/{baseId}... 自动提取
  const m = String(p.baseId || '').match(/nodes\/([A-Za-z0-9]+)/)
  if (m) p.baseId = m[1]
  const ps = [...(state.projects || [])]
  if (p.id) {
    const idx = ps.findIndex((x) => x.id === p.id)
    if (idx < 0) throw new Error('项目不存在')
    ps[idx] = { ...ps[idx], ...p }
  } else {
    if (!p.name?.trim()) throw new Error('项目名称不能为空')
    if (!p.baseId?.trim() && p.status !== 'pending') throw new Error('请填写AI表格链接或Base ID')
    p.id = `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    p.createdAt = Date.now()
    ps.push(p)
  }
  state.projects = ps
  persist()
  return structuredClone(ps.find((x) => x.id === p.id) || p)
}

export function deleteProject(id) {
  const ps = state.projects || []
  if (!ps.some((x) => x.id === id)) throw new Error('项目不存在')
  state.projects = ps.filter((x) => x.id !== id)
  persist()
}

/** 语音识别生效配置（讯飞三项齐备即启用） */
export function getAsr() {
  const a = state.asr
  const merged = {
    ...a,
    appId: a.appId || process.env.XF_APP_ID || '',
    apiKey: a.apiKey || process.env.XF_API_KEY || '',
    apiSecret: a.apiSecret || process.env.XF_API_SECRET || '',
  }
  return { ...merged, enabled: Boolean(merged.appId && merged.apiKey && merged.apiSecret) }
}
