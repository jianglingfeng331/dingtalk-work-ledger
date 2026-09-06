import { Router } from 'express'
import { config } from '../config.js'
import { getUserByAuthCode, signJsapi } from '../services/dingtalk.js'
import { createSession } from '../services/session.js'
import { getPairedDesktopUser } from '../services/desktop-pair.js'
import { isAdmin, get as getSettings, update as updateSettings } from '../services/settings.js'
import { fixRecorderName } from '../services/store.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

/**
 * POST /api/login 钉钉免登（免鉴权）
 * body: { code }  钉钉内：JSAPI免登码
 * 无免登码场景：未配置凭据=演示模式；已配置且 ALLOW_DEV_LOGIN=1 =浏览器访客（普通权限）
 */
router.post(
  '/login',
  asyncRoute(async (req, res) => {
    const { code } = req.body || {}

    let user
    if (code && config.dingtalkEnabled) {
      // 钉钉免登：免登码换用户；管理员身份由动态配置决定
      try {
        user = await getUserByAuthCode(code)
      } catch (err) {
        console.error('[login] 钉钉免登失败:', err?.message)
        return fail(res, `钉钉免登失败：${err?.message || '未知错误'}`)
      }
      user.isAdmin = isAdmin(user.userId, user.source)
      // 拿到真实姓名：回溯修正历史记录里“钉钉用户-xxxx”的旧显示名
      const fixed = fixRecorderName(user.userId, user.name)
      if (fixed) console.log(`[login] 已回溯修正 ${fixed} 条历史记录的记录人姓名`)
      // 管理员首次免登：自动回填AI表格操作人UnionId，免去手工查询
      if (user.isAdmin && user.unionId && !getSettings().table.operatorUnionId) {
        updateSettings({ table: { operatorUnionId: user.unionId } })
        console.log('[login] 已自动记录管理员UnionId作为AI表格操作人')
      }
      console.log(`[login] 免登成功: ${user.userId}(${user.name})`)
    } else if (req.body?.desktopToken) {
      const given = String(req.body.desktopToken)
      // 1. 扫码配对签发的个人长期凭据（每个桌面端使用者独立身份，权限与钉钉会话一致）
      const paired = getPairedDesktopUser(given)
      if (paired) {
        user = { ...paired }
        user.isAdmin = isAdmin(user.userId, user.source)
        console.log(`[login] 桌面端配对登录: ${user.userId}(${user.name})`)
      } else if (getSettings().desktop?.token && given === getSettings().desktop.token) {
        // 2. 旧版管理员全局桌面令牌（保留兼容，身份绑定生成者）
        const d = getSettings().desktop
        user = {
          userId: d.userId,
          name: d.name || '桌面端',
          unionId: d.unionId || '',
          source: 'desktop',
          isAdmin: isAdmin(d.userId, 'desktop'),
        }
        if (!user.isAdmin) return fail(res, '桌面令牌绑定的用户已不是管理员', 403)
        console.log(`[login] 桌面端令牌登录: ${user.userId}(${user.name})`)
      } else {
        return fail(res, '桌面端令牌无效，请使用钉钉扫码登录或在钉钉「设置」页重新生成', 401)
      }
    } else if (!config.dingtalkEnabled || config.allowDevLogin) {
      // 演示模式本地用户为管理员；正式模式访客仅普通权限（只能看本人数据，不能管理设置/项目）
      user = {
        userId: 'local-guest',
        name: config.dingtalkEnabled ? '浏览器访客' : '演示用户',
        source: 'local',
        isAdmin: !config.dingtalkEnabled,
      }
    } else {
      return fail(res, '缺少免登授权码，请在钉钉内打开应用')
    }

    const { token, user: userInfo } = createSession(user)
    ok(res, { ...userInfo, token })
  }),
)

/**
 * JSAPI 鉴权签名路由（需登录；dd.config 录音等客户端能力均在登录后使用）
 * GET /api/jsapi-sign?url=xxx
 */
export const jsapiRouter = Router()
jsapiRouter.get(
  '/jsapi-sign',
  asyncRoute(async (req, res) => {
    if (!config.dingtalkEnabled) return fail(res, '未配置钉钉应用凭据', 400)
    const url = String(req.query.url || '').split('#')[0]
    if (!/^https?:\/\//.test(url)) return fail(res, 'url 参数无效', 400)
    ok(res, await signJsapi(url))
  }),
)

export default router
