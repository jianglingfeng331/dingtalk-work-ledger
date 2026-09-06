import { reactive } from 'vue'
import request from './request'
import * as mock from './mock'

/**
 * 统一 API 层：优先请求真实后端（阶段二），请求失败自动降级为本地演示数据。
 * 后端就绪后无需改前端代码，接口连通即自动切换。
 */
export const runtime = reactive({ mockMode: false })

/** 某请求失败降级本地演示（头部显示"演示"标签） */
function fallback() {
  runtime.mockMode = true
}

/** 后端恢复响应即熄灭"演示"标签：网络抖动/部署切换期的一次失败不应整个会话挂着演示标记 */
function recover() {
  if (runtime.mockMode) runtime.mockMode = false
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
    recover()
    if (!keepDiag) clearLoginError() // 成功即清除历史诊断，避免旧记录误导
    return res
  } catch (err) {
    recordLoginError(err)
    // 免登失败：优先续访客会话（数据仍进后端、设置页可用），并保留诊断供排查
    if (params?.code) {
      try {
        const res = await request.post('/login', { dev: true })
        recover()
        return res
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
    const res = await request.post('/submit-work', { content, overrides, taskId }, { timeout: 35000 })
    recover()
    return res
  } catch {
    fallback()
    return mock.mockSubmitWork(content, localUser())
  }
}

/** 获取工作记录 scope: all | today | week | undone；team=1 管理员查全员 */
export async function getWorkList(params = {}) {
  try {
    const res = await request.get('/get-work-list', { params })
    recover()
    return res
  } catch {
    fallback()
    return mock.mockGetWorkList(params)
  }
}

/**
 * AI 智能查询（SSE 流式）：后端 MCP 实时拉台账数据 + LLM 推理，模型边生成边推送。
 * @param {string} question
 * @param {{onToken?:(delta:string, full:string)=>void}} [opts] onToken 逐字回调
 * @returns {Promise<string>} 完整回答（done 时 resolve）
 */
export async function aiQuery(question, { onToken } = {}) {
  const base = import.meta.env.VITE_API_BASE_URL || '/api'
  const buildHeaders = () => {
    const h = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
    const token = localStorage.getItem('work_token')
    if (token) h.Authorization = `Bearer ${token}`
    const pid = localStorage.getItem('work_project_id')
    if (pid) h['x-project-id'] = pid
    return h
  }

  const attempt = async () => {
    let resp
    try {
      resp = await fetch(base + '/ai-query', { method: 'POST', headers: buildHeaders(), body: JSON.stringify({ question }) })
    } catch (networkErr) {
      throw new Error('网络连接失败，请检查网络后重试')
    }
    const ctype = resp.headers.get('content-type') || ''
    // 非 SSE 响应（鉴权失败/网关 502 等）：解析 JSON 错误并带上 code
    if (!resp.ok || !ctype.includes('text/event-stream')) {
      let msg = `AI 查询失败（HTTP ${resp.status}）`
      let code = resp.status
      try {
        const j = await resp.json()
        if (j?.message) msg = j.message
        if (j?.code) code = j.code
      } catch {
        /* 非 JSON 错误体，保留默认文案 */
      }
      const e = new Error(msg)
      e.code = code
      throw e
    }

    // 解析 SSE：事件以空行分隔，每行 `data: {json}`（`: ping` 心跳行自动忽略）
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    const readWithTimeout = (ms = 30_000) => {
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('AI 响应超时，请稍后重试')), ms)
      })
      return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer))
    }
    let buffer = ''
    let full = ''
    const parseLine = (rawEvent) => {
      const line = rawEvent.split('\n').find((l) => l.trimStart().startsWith('data:'))
      if (!line) return null
      const payload = line.slice(line.indexOf('data:') + 5).trim()
      if (!payload) return null
      try {
        return JSON.parse(payload)
      } catch {
        return null
      }
    }
    const handle = (evt) => {
      if (!evt) return false
      if (evt.type === 'token') {
        full += evt.content || ''
        onToken?.(evt.content || '', full)
        return false
      }
      if (evt.type === 'done') {
        full = evt.answer || full
        return true
      }
      if (evt.type === 'error') {
        throw new Error(evt.message || 'AI 查询失败，请稍后重试')
      }
      return false
    }
    try {
      for (;;) {
        const { value, done } = await readWithTimeout()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          if (handle(parseLine(rawEvent))) return full
        }
      }
      buffer += decoder.decode()
      // 流结束：解析残留事件（连接在事件边界前截断时不丢最后一条）
      for (const line of buffer.split('\n')) {
        if (handle(parseLine(line))) return full
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    return full // 流提前结束：返回已接收的部分内容
  }

  // 非流式降级：一次性拿完整答案（流式在部分客户端会被中途掐断，此时自动切换此稳定链路）
  const fallbackNonStream = async () => {
    const res = await request.post('/ai-query?stream=0', { question }, { timeout: 95000 })
    return res?.answer || ''
  }

  try {
    const answer = await attempt()
    // 流式拿到完整答案；若流被掐断且一字未得（空内容），降级非流式重试
    if (answer && answer.trim()) return answer
    return await fallbackNonStream()
  } catch (err) {
    // 401 会话过期：自愈重新登录后重试一次（与 axios 拦截器策略一致）
    if (err?.code === 401) {
      try {
        const { relogin } = await import('../utils/user')
        if (await relogin()) {
          const retry = await attempt()
          if (retry && retry.trim()) return retry
          return await fallbackNonStream()
        }
      } catch {
        /* 重新登录失败则按普通错误抛出 */
      }
    }
    // 流式路径异常（非 401）：已收内容则直接用，否则降级非流式再试一次
    try {
      const viaFallback = await fallbackNonStream()
      if (viaFallback && viaFallback.trim()) return viaFallback
    } catch {
      /* 降级也失败则抛出原始错误 */
    }
    throw err
  }
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

/** 修改任务状态（仅负责人，服务端二次校验） */
export function updateTaskStatus(taskId, status) {
  return request.post(`/tasks/${encodeURIComponent(taskId)}/status`, { status }, { timeout: 30000 })
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

/* ===================== 领导指令模块（写领导指令表+任务表联动） ===================== */

/** 指令AI预解析（不入库）：口语化指令 → { title, owners[], deadline, status }，人工可编辑 */
export function parseDirective(content) {
  return request.post('/parse-directive', { content }, { timeout: 30000 })
}

/** 下达指令（仅领导角色/管理员）：{ title, ownerNames[], deadline, status? } */
export function submitDirective(payload) {
  return request.post('/submit-directive', payload, { timeout: 45000 })
}

/** 指令清单（仅领导/管理员；含关联任务实时状态） */
export function getDirectives() {
  return request.get('/directives', { timeout: 30000 })
}

/** 项目成员清单（管理员；设置页领导角色姓名匹配用） */
export function getProjectMembers(projectId) {
  return request.get(`/projects/${encodeURIComponent(projectId)}/members`, { timeout: 30000 })
}

/** 智能润色：口语化内容 → 通顺书面工作描述（可选步骤；LLM偶发限流重试较慢，放宽等待） */
export async function enrichWork(content) {
  return request.post('/enrich-work', { content }, { timeout: 60000 })
}

/** 项目管理：我的项目列表（管理员=全部；成员=按项目成员表过滤）；pendingProjects=待审核项目 */
export function getProjects() {
  return request.get('/projects', { timeout: 20000 })
}

/** 新建/更新项目（所有登录用户；普通用户新建进入待审核；baseId 支持直接粘贴钉钉文档链接；autoCreateTable=审批通过后服务端自动建表） */
export function saveProjectApi(payload) {
  return request.post('/projects', payload, { timeout: 90000 })
}

/** 审核通过待审核项目（仅管理员；待自动建表时审批约需5-15秒） */
export function approveProjectApi(id) {
  return request.post(`/projects/${encodeURIComponent(id)}/approve`, {}, { timeout: 90000 })
}

/** 拒绝待审核项目（仅管理员，移除该项目配置） */
export function rejectProjectApi(id) {
  return request.post(`/projects/${encodeURIComponent(id)}/reject`, {}, { timeout: 20000 })
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

/** 桌面版（秒建功）令牌：查询/生成/撤销（仅管理员） */
export async function getDesktopTokenApi() {
  return request.get('/desktop-token')
}
export async function createDesktopTokenApi() {
  return request.post('/desktop-token')
}
export async function revokeDesktopTokenApi() {
  return request.delete('/desktop-token')
}

/** 桌面端扫码配对：授权页查询配对状态 */
export async function getPairStatusApi(pairId) {
  return request.get(`/desktop-pair/${pairId}`)
}
/** 桌面端扫码配对：确认授权（身份为当前钉钉登录用户） */
export async function confirmPairApi(pairId) {
  return request.post(`/desktop-pair/${pairId}/confirm`)
}
