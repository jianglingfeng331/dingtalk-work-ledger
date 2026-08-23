import axios from 'axios'

/**
 * 统一请求封装
 * 后端响应约定（阶段二实现）：{ code: 0, data: any, message: string }
 *
 * 会话自愈：服务重启后旧token失效（code=401），此处自动重新登录并重试一次原请求，
 * 避免"服务重启 → 旧token 401 → 静默降级演示数据"导致列表错乱（用户只看到1条本地记录）。
 */
let reloginFn = null

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 15000,
})

request.interceptors.request.use((config) => {
  const token = localStorage.getItem('work_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  // 当前项目：所有业务接口携带，后端按项目路由到对应AI表格（设置页切换）
  const pid = localStorage.getItem('work_project_id')
  if (pid) config.headers['x-project-id'] = pid
  return config
})

request.interceptors.response.use(
  async (res) => {
    const body = res.data
    // 非 {code,data,message} 结构直接透传
    if (body === null || typeof body !== 'object' || !('code' in body)) return body
    // 登录过期：重新登录后重试一次（防循环）
    if (body.code === 401 && !res.config.__retried) {
      res.config.__retried = true
      try {
        reloginFn = reloginFn || (await import('../utils/user')).relogin
        const ok = await reloginFn()
        if (ok) return request(res.config)
      } catch {
        /* 重新登录失败，按普通错误处理 */
      }
    }
    if (body.code !== 0) {
      const err = new Error(body.message || '请求失败')
      err.code = body.code
      throw err
    }
    // 挂后端提示语（如"已保存，网络恢复后自动同步表格"），不可枚举不影响数据使用
    if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
      try {
        Object.defineProperty(body.data, '__message', { value: body.message || '', enumerable: false })
      } catch {
        /* 冻结对象等极端情况忽略 */
      }
    }
    return body.data
  },
  async (err) => {
    // 后端错误已透传真实 HTTP 状态码（401/403/404等）：从响应体提取 {code,message}，
    // 与成功路径同构处理（401 自愈重试 / 非 0 抛中文错误），避免露出 axios 英文报错
    const body = err?.response?.data
    if (body !== null && typeof body === 'object' && 'code' in body) {
      if (body.code === 401 && !err.config.__retried) {
        err.config.__retried = true
        try {
          reloginFn = reloginFn || (await import('../utils/user')).relogin
          const relogged = await reloginFn()
          if (relogged) return request(err.config)
        } catch {
          /* 重新登录失败，按普通错误处理 */
        }
      }
      if (body.code !== 0) {
        const e = new Error(body.message || '请求失败')
        e.code = body.code
        throw e
      }
      return body.data
    }
    return Promise.reject(err)
  },
)

export default request
