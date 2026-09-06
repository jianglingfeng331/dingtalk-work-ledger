import crypto from 'node:crypto'
import { createSession } from './session.js'

/**
 * 桌面端「钉钉扫码配对」服务
 *
 * 链路：桌面端发起配对 → 显示二维码（钉钉内打开授权页）→ 用户在钉钉里确认授权
 *       → 服务端为该用户签发会话 + 个人长期桌面凭据 → 桌面端轮询取走，完成登录。
 *
 * 安全要点：
 * - pairId 为 128bit 随机串，不可猜测；配对 5 分钟过期
 * - 确认授权必须携带有效钉钉会话（auth 中间件），身份即扫码本人
 * - 轮询取走结果后配对记录立即删除（一次性）
 * - 个人桌面凭据（pairedTokens）仅用于桌面端会话过期后的自动重登，与令牌等价
 */

const PAIR_TTL_MS = 5 * 60 * 1000

/** pairId -> { status, createdAt, expiresAt, result } */
const pairs = new Map()

/** 个人桌面长期凭据 -> 登录时的用户快照（source 保留 dingtalk，权限判定与 H5 一致） */
const pairedTokens = new Map()

function sweep() {
  const now = Date.now()
  for (const [id, p] of pairs) {
    if (p.expiresAt <= now) pairs.delete(id)
  }
}

/** 桌面端发起配对：返回 pairId（二维码链接参数） */
export function createPair() {
  sweep()
  const pairId = crypto.randomBytes(16).toString('hex')
  pairs.set(pairId, {
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + PAIR_TTL_MS,
    result: null,
  })
  return { pairId, expiresInSec: Math.round(PAIR_TTL_MS / 1000) }
}

function getLive(pairId) {
  const p = pairs.get(pairId)
  if (!p) return { status: 'notfound' }
  if (p.expiresAt <= Date.now()) {
    pairs.delete(pairId)
    return { status: 'expired' }
  }
  return { status: p.status, pair: p }
}

/** H5 授权页查询配对状态（pending / confirmed / expired / notfound） */
export function pairStatus(pairId) {
  return { status: getLive(pairId).status }
}

/**
 * H5 确认授权：为扫码人生成会话与个人桌面凭据。
 * user 为 auth 中间件校验后的钉钉会话用户。
 * 浏览器访客（source=local 且非钉钉环境）不允许授权，避免把桌面端绑到匿名身份。
 */
export function confirmPair(pairId, user) {
  const { status, pair } = getLive(pairId)
  if (status !== 'pending') return { ok: false, status }
  if (!user || user.source === 'local') {
    return { ok: false, status: 'forbidden' }
  }

  // 个人长期桌面凭据：桌面端会话过期后凭它自动重登（等价旧桌面令牌，但人人独立）
  const desktopToken = crypto.randomBytes(24).toString('hex')
  pairedTokens.set(
    desktopToken,
    { userId: user.userId, name: user.name, unionId: user.unionId || '', source: user.source },
  )

  // 正式会话：与 H5 登录同一条会话链路，权限完全一致
  const { token } = createSession({
    userId: user.userId,
    name: user.name,
    unionId: user.unionId || '',
    source: user.source,
  })

  pair.status = 'confirmed'
  pair.result = { token, desktopToken, name: user.name, userId: user.userId }
  return { ok: true, status: 'confirmed' }
}

/**
 * 桌面端轮询：confirmed 时一次性返回登录结果并删除配对记录。
 * 返回 { status } 或 { status:'confirmed', token, desktopToken, name, userId }
 */
export function consumePair(pairId) {
  const { status, pair } = getLive(pairId)
  if (status !== 'confirmed') return { status }
  const result = pair.result
  pairs.delete(pairId)
  return { status: 'confirmed', ...result }
}

/** 个人桌面凭据换用户快照（/api/login 用）；未命中返回 null */
export function getPairedDesktopUser(desktopToken) {
  return pairedTokens.get(desktopToken) || null
}
