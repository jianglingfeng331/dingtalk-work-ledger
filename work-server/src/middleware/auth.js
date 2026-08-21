import { getUserByToken } from '../services/session.js'
import { isAdmin } from '../services/settings.js'
import { fail } from '../utils/respond.js'

/**
 * 身份校验中间件：校验 Authorization: Bearer <token>
 * 管理员身份每次请求实时判定（设置页改管理员列表立即生效）
 */
export function auth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const user = token && getUserByToken(token)

  if (!user) return fail(res, '未登录或登录已过期', 401, 200)
  user.isAdmin = isAdmin(user.userId, user.source)
  // 当前项目：前端每次请求携带 x-project-id 头，未携带取默认（第一个项目）
  user.projectId = String(req.headers['x-project-id'] || '').trim()
  req.user = user
  next()
}
