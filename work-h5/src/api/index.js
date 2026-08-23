import { reactive } from 'vue'
import request from './request'
import * as mock from './mock'

/**
 * 统一 API 层：优先请求真实后端（阶段二），请求失败自动降级为本地演示数据。
 * 后端就绪后无需改前端代码，接口连通即自动切换。
 */
export const runtime = reactive({ mockMode: false })

function fallback() {
  runtime.mockMode = true
}

function localUser() {
  try {
    return JSON.parse(localStorage.getItem('work_user') || 'null') || {}
  } catch {
    return {}
  }
}

/** 记录登录诊断（设置页运行状态可见），成功登录时清除 */
function recordLoginError(err) {
  const detail = {
    time: new Date().toLocaleString(),
    env: /DingTalk/i.test(navigator.userAgent) ? 'dingtalk' : 'browser',
    corpId: Boolean(import.meta.env.VITE_DINGTALK_CORP_ID) ? '已配置' : '缺失(需重新构建)',
    msg: err?.message || String(err),
  }
  try {
    localStorage.setItem('last_login_error', JSON.stringify(detail))
  } catch {
    /* ignore */
  }
  console.error('[login] 登录失败:', detail)
}

function clearLoginError() {
  try {
    localStorage.removeItem('last_login_error')
  } catch {
    /* ignore */
  }
}

/** 钉钉免登：用免登码换取用户信息与 token（失败时记录诊断信息后降级访客） */
export async function login(params, { keepDiag = false } = {}) {
  try {
    const res = await request.post('/login', params)
    if (!keepDiag) clearLoginError() // 成功即清除历史诊断，避免旧记录误导
    return res
  } catch (err) {
    recordLoginError(err)
    // 免登失败：优先续访客会话（数据仍进后端、设置页可用），并保留诊断供排查
    if (params?.code) {
      try {
        return await request.post('/login', { dev: true })
      } catch {
        /* 后端不可用才走本地 mock */
      }
    }
    fallback()
    return mock.mockLogin()
  }
}

/** 提交工作内容（后端结构化解析 + 任务关联 + 同步钉钉AI表格）；overrides 为用户确认卡修改的字段
 * taskId：用户显式选择的关联任务记录ID（空则后端智能匹配）
 * 超时35s：容纳智谱偶发限流重试与AI语义匹配（规则匹配先行，通常2-4s完成） */
export async function submitWork(content, overrides = {}, taskId = '') {
  try {
    return await request.post('/submit-work', { content, overrides, taskId }, { timeout: 35000 })
  } catch {
    fallback()
    return mock.mockSubmitWork(content, localUser())
  }
}

/** 获取工作记录 scope: all | today | week | undone；team=1 管理员查全员 */
export async function getWorkList(params = {}) {
  try {
    return await request.get('/get-work-list', { params })
  } catch {
    fallback()
    return mock.mockGetWorkList(params)
  }
}

/** AI 智能查询（后端：MCP 拉取台账数据 + LLM 推理；正式版不做本地演示降级，失败明确报错） */
export async function aiQuery(question) {
  return request.post('/ai-query', { question }, { timeout: 60000 })
}

/** 任务视图：任务清单+关联日志聚合（来源钉钉AI表格，未接表格返回 enabled:false）
 * params.mine=1 只返回与当前用户相关的任务（负责人或参与人含该用户） */
export function getTasks(params = {}) {
  return request.get('/tasks', { params, timeout: 30000 })
}

/** 单任务关联日志（时间倒序，最多50条） */
export function getTaskLogs(taskId) {
  return request.get(`/tasks/${encodeURIComponent(taskId)}/logs`, { timeout: 30000 })
}

/** 预解析工作内容（语音/文字 → 结构化字段预览，不入库） */
export async function parseWork(content) {
  return request.post('/parse-work', { content })
}

/* ===================== 计划模块（写入任务表） ===================== */

/** 计划确认卡选项：项目成员（含unionId）+ 任务分类 */
export function getPlanOptions() {
  return request.get('/plan-options', { timeout: 30000 })
}

/** AI预解析计划（任务标题/负责人/计划节点/任务分类；解析不出的留空由用户补） */
export function parsePlan(content) {
  return request.post('/parse-plan', { content }, { timeout: 30000 })
}

/** 提交计划 → 钉钉任务表 */
export function submitPlan(payload) {
  return request.post('/submit-plan', payload, { timeout: 30000 })
}

/** 智能润色：口语化内容 → 通顺书面工作描述（可选步骤；LLM偶发限流重试较慢，放宽等待） */
export async function enrichWork(content) {
  return request.post('/enrich-work', { content }, { timeout: 60000 })
}

/** 项目管理：我的项目列表（管理员=全部；成员=按项目成员表过滤） */
export function getProjects() {
  return request.get('/projects', { timeout: 20000 })
}

/** 新建/更新项目（仅管理员；baseId 支持直接粘贴钉钉文档链接） */
export function saveProjectApi(payload) {
  return request.post('/projects', payload, { timeout: 20000 })
}

/** 删除项目（仅管理员，仅移除配置，AI表格数据不动） */
export function deleteProjectApi(id) {
  return request.delete(`/projects/${encodeURIComponent(id)}`, { timeout: 20000 })
}

/** 项目连接测试（仅管理员，先保存后测试） */
export function testProject(id, baseId, sheetId, operatorUnionId) {
  return request.post('/projects/test', { id, baseId, sheetId, operatorUnionId }, { timeout: 20000 })
}

/** 读取系统配置与运行状态 */
export async function getSettings() {
  return request.get('/settings')
}

/** 更新系统配置（仅管理员；apiKey 传空表示保持不变） */
export async function updateSettings(payload) {
  return request.put('/settings', payload)
}
