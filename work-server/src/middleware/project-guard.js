import { config } from '../config.js'
import { getTable, listProjects } from '../services/settings.js'
import { listMembers } from '../services/dingtalk-table.js'
import { fail } from '../utils/respond.js'

/**
 * 跨项目越权防护：校验请求头 x-project-id 指定的项目与登录用户的成员关系
 * - 管理员 / 演示模式（未配置钉钉凭据，无表格数据）直接放行
 * - 未携带项目 / 项目ID不存在 → 拒绝：禁止利用 getTable('') 静默回落 projects[0]
 *   （否则非成员不带 x-project-id 也能看到默认项目的任务/日志，且提交会写入默认项目）
 * - 成员表可读且不含该用户 → 403；成员表读取失败或为空 → 兜底放行（与 /api/projects 过滤口径一致，防误伤）
 * 判定结果缓存 5 分钟，避免每个请求都拉取成员表
 */
const TTL_MS = 5 * 60 * 1000
const cache = new Map() // `${userId}|${projectId}` -> { verdict, ts }

/** 判定结果：yes成员 / no非成员 / unknown无法判定（兜底放行）/ invalid项目不存在 */
async function verdictOf(user, pid) {
  const key = `${user.userId}|${pid}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.verdict

  let verdict = 'unknown'
  const p = listProjects().find((x) => x.id === pid)
  if (!p) {
    verdict = 'invalid'
  } else if (getTable(p.id).enabled) {
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
    if (req.user.isAdmin || !config.dingtalkEnabled) return next()
    if (!pid) {
      return fail(res, '请先选择项目；如无可用项目，请联系管理员将你加入项目成员表', 400)
    }
    const verdict = await verdictOf(req.user, pid)
    if (verdict === 'invalid') return fail(res, '项目不存在或已删除', 404)
    if (verdict !== 'no') return next()
    console.warn(`[guard] 越权拦截: user=${req.user.userId}(${req.user.name}) project=${pid}`)
    fail(res, '你不在该项目成员表中，无权访问该项目数据', 403)
  } catch (err) {
    next(err)
  }
}
