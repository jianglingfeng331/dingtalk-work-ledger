/* 秒建功 · 渲染层 API：登录自愈 / 流式查询 / 填报 / 项目 */
// 服务器地址固定（随安装包出厂），无需用户填写
const DEFAULT_SERVER = 'http://101.37.210.127:3001'
const LS = {
  serverUrl: () => {
    const v = localStorage.getItem('serverUrl')
    // 旧版本默认值缺端口，统一迁移到固定地址
    if (!v || v === 'http://101.37.210.127') return DEFAULT_SERVER
    return v
  },
  token: () => localStorage.getItem('token') || '',
  desktopToken: () => localStorage.getItem('desktopToken') || '',
  projectId: () => localStorage.getItem('projectId') || '',
}

/** 当前服务器地址（供交互层拼配对链接用） */
function currentServer() {
  return LS.serverUrl()
}

let loginPromise = null

/** 桌面令牌换正式会话；失败抛错（提示配置） */
async function loginByToken() {
  const dt = LS.desktopToken()
  if (!dt) throw new Error('未配置桌面令牌，请打开设置填写')
  const res = await fetch(`${LS.serverUrl()}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desktopToken: dt }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.code !== 0) throw new Error(j.message || `登录失败(${res.status})`)
  localStorage.setItem('token', j.data.token)
  localStorage.setItem('userName', j.data.name || '')
  return j.data
}

/** 确保已登录（有 token 直接用；失效/无 token 用桌面令牌重换） */
async function ensureLogin() {
  if (LS.token()) return true
  if (!LS.desktopToken()) return false
  try {
    await loginByToken()
    return true
  } catch {
    return false
  }
}

/** 通用请求：自动带鉴权与项目头；401 自动重登一次 */
async function request(path, { method = 'GET', body, retry = true, raw = false } = {}) {
  const headers = { Authorization: `Bearer ${LS.token()}` }
  const pid = LS.projectId()
  if (pid) headers['x-project-id'] = pid
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${LS.serverUrl()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && retry && LS.desktopToken()) {
    localStorage.removeItem('token')
    await loginByToken()
    return request(path, { method, body, retry: false, raw })
  }
  if (raw) return res
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.code !== 0) throw new Error(j.message || `请求失败(${res.status})`)
  return j.data
}

/** 钉钉扫码配对：桌面端发起配对，返回 { pairId, expiresInSec } */
async function createPair() {
  const res = await fetch(`${LS.serverUrl()}/api/desktop-pair`, { method: 'POST' })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.code !== 0) throw new Error(j.message || `配对失败(${res.status})`)
  return j.data
}

/** 钉钉扫码配对：轮询授权结果；confirmed 时一次性返回 { token, desktopToken, name } */
async function pollPair(pairId) {
  const res = await fetch(`${LS.serverUrl()}/api/desktop-pair/${pairId}/poll`)
  const j = await res.json().catch(() => ({}))
  if (res.status === 410) return { status: 'expired' }
  if (!res.ok || j.code !== 0) throw new Error(j.message || `查询失败(${res.status})`)
  return j.data
}

/** 配对成功后保存登录态（会话 token + 个人长期凭据，供 401 自愈） */
function savePairedSession(d) {
  localStorage.setItem('token', d.token)
  localStorage.setItem('desktopToken', d.desktopToken)
  localStorage.setItem('userName', d.name || '')
}

/** 项目列表（含当前项目标记与 AI 表格地址） */
async function getProjects() {
  const d = await request('/api/projects')
  return d || {}
}

/** 我的任务（未完成） */
async function getMyTasks() {
  const d = await request('/api/tasks?mine=1')
  return (d && d.tasks) || []
}

/** AI 查询（SSE 流式，失败自动降级非流式） */
async function aiQueryStream(question, { onToken, onDone, onError } = {}) {
  const t0 = Date.now()
  try {
    const res = await request('/api/ai-query', { method: 'POST', body: { question }, raw: true })
    if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) throw new Error('非流式响应')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let answer = ''
    // 读超时看门狗：30s 无数据视为挂起
    let timer = setTimeout(() => reader.cancel().catch(() => {}), 30000)
    const bump = () => {
      clearTimeout(timer)
      timer = setTimeout(() => reader.cancel().catch(() => {}), 30000)
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bump()
      buf += decoder.decode(value, { stream: true })
      const events = buf.split('\n\n')
      buf = events.pop() || ''
      for (const ev of events) {
        const line = ev.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        let d
        try {
          d = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        if (d.type === 'token') {
          answer += d.content
          onToken?.(d.content)
        } else if (d.type === 'done') {
          clearTimeout(timer)
          onDone?.(d.answer || answer, d.scope)
          return
        } else if (d.type === 'error') {
          throw new Error(d.message)
        }
      }
    }
    if (answer) {
      onDone?.(answer)
      return
    }
    throw new Error('流提前结束')
  } catch (err) {
    console.warn('[ai] 流式失败，降级非流式:', err.message)
    try {
      const d = await request('/api/ai-query?stream=0', { method: 'POST', body: { question }, retry: false })
      onDone?.(d.answer, d.scope)
    } catch (e2) {
      onError?.(e2.message || 'AI 查询失败')
    }
  }
}

/** 自然语言 → 结构化预览（不入库） */
async function parseWork(content) {
  return request('/api/parse-work', { method: 'POST', body: { content } })
}

/** 提交工作记录 */
async function submitWork(content, overrides, taskId) {
  return request('/api/submit-work', { method: 'POST', body: { content, overrides, taskId } })
}

/** 智能润色（口语化工作描述 → 通顺书面记录） */
async function enrichWork(content) {
  return request('/api/enrich-work', { method: 'POST', body: { content } })
}

/** 项目 AI 表格地址 */
function tableUrl(baseId) {
  return `https://alidocs.dingtalk.com/i/nodes/${baseId}`
}

/** 登出（撤销本地会话） */
function logout() {
  localStorage.removeItem('token')
}
