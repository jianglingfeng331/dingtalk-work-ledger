/** 统一响应格式：{ code: 0, data, message } */
export function ok(res, data = null, message = 'ok') {
  res.json({ code: 0, data, message })
}

export function fail(res, message = '服务异常', code = 1, status = 200) {
  res.status(status).json({ code, data: null, message })
}

/** 包装异步路由，统一异常出口 */
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)
