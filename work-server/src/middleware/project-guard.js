import { getTable, listProjects } from '../services/settings.js'
import { listMembers } from '../services/dingtalk-table.js'
import { fail } from '../utils/respond.js'

/**
 * 跨项目越权防护：校验请求头 x-project-id 指定的项目与登录用户的成员关系
 * - 管理员 / 未携带项目 / 项目表格未启用（演示模式）直接放行
 * - 成员表可读且不含该用户 → 403；成员表读取失败或为空 → 兜底放行（与 /api/projects 过滤口径一致，防误伤）
 * 判定结果缓存 5 分钟，避免每个请求都拉取成员表
 */
const TTL_MS = 5 * 60 * 1000
const cache = new Map() // `${userId}|${projectId}` -> { verdict, ts }

async function verdictOf(user, pid) {
  const key = `${user.userId}|${pid}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.verdict

  let verdict = 'unknown'
  const p = listProjects().find((x) => x.id === pid)
  if (p && getTable(p.id).enabled) {
    try {
      const members = await listMembers(user.unionId || p.operatorUnionId || '', p.id)
      if (members.length) {
        verdict = members.some((m) => m.unionId && m.unionId === user.unionId) ? 'yes' : 'no'
      }
    } catch {
      /* 成员表读取失败维持 unknown 兜底放行 */
    }
  }
  cache.set(key, { verdict, ts: Date.now() })
  return verdict
}

export async function projectGuard(req, res, next) {
  try {
    const pid = req.user?.projectId
    if (!pid || req.user.isAdmin || (await verdictOf(req.user, pid)) !== 'no') return next()
    console.warn(`[guard] 越权拦截: user=${req.user.userId}(${req.user.name}) project=${pid}`)
    fail(res, '你不在该项目成员表中，无权访问该项目数据', 403)
  } catch (err) {
    next(err)
  }
}
