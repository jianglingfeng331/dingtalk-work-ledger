import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import {
  confirmPair,
  consumePair,
  createPair,
  pairStatus,
} from '../services/desktop-pair.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

/**
 * 桌面端「钉钉扫码配对」路由
 * - POST   /api/desktop-pair              桌面端发起配对（免鉴权，pairId 为 128bit 随机）
 * - GET    /api/desktop-pair/:id/poll     桌面端轮询结果（免鉴权，confirmed 后一次性取走）
 * - GET    /api/desktop-pair/:id          H5 授权页查状态（需钉钉会话）
 * - POST   /api/desktop-pair/:id/confirm  H5 确认授权（需钉钉会话）
 */
const router = Router()

router.post(
  '/desktop-pair',
  asyncRoute(async (req, res) => {
    ok(res, createPair())
  }),
)

router.get(
  '/desktop-pair/:pairId/poll',
  asyncRoute(async (req, res) => {
    const result = consumePair(req.params.pairId)
    // 过期/不存在用 410/404 语义，桌面端据此停止轮询
    if (result.status === 'expired') return fail(res, '二维码已过期，请重新获取', 410)
    if (result.status === 'notfound') return fail(res, '配对不存在，请重新获取二维码', 404)
    ok(res, result)
  }),
)

router.get(
  '/desktop-pair/:pairId',
  auth,
  asyncRoute(async (req, res) => {
    ok(res, pairStatus(req.params.pairId))
  }),
)

router.post(
  '/desktop-pair/:pairId/confirm',
  auth,
  asyncRoute(async (req, res) => {
    const r = confirmPair(req.params.pairId, req.user)
    if (!r.ok) {
      if (r.status === 'forbidden') return fail(res, '请在钉钉中打开本页面完成授权', 403)
      if (r.status === 'expired') return fail(res, '二维码已过期，请在桌面端重新获取', 410)
      return fail(res, '配对不可用，请在桌面端重新获取二维码', 404)
    }
    console.log(`[pair] 桌面端配对授权成功: ${req.user.userId}(${req.user.name})`)
    ok(res, { status: 'confirmed' })
  }),
)

export default router
