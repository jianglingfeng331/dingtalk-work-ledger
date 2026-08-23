/**
 * 统一响应封装
 * 约定：{ code: 0, data: any, message: string }
 * 错误时按业务码映射真实 HTTP 状态码（4xx/5xx 同值透传），便于监控/网关按状态码告警；
 * 其余业务码（如 1=通用校验失败）保持 200，前端统一按 code 判断，行为不变
 */
function statusOf(code) {
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : 200
}

export function ok(res, data = null, message = 'ok') {
  res.json({ code: 0, data, message })
}

export function fail(res, message = '服务异常', code = 1, status) {
  res.status(status ?? statusOf(code)).json({ code, data: null, message })
}

/** 包装异步路由，统一异常出口 */
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)
