import { Router } from 'express'
import { config } from '../config.js'
import { getUserByAuthCode, signJsapi } from '../services/dingtalk.js'
import { createSession } from '../services/session.js'
import { isAdmin, get as getSettings, update as updateSettings } from '../services/settings.js'
import { fixRecorderName } from '../services/store.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

/**
 * GET /api/login/jsapi-sign?url=xxx  JSAPI 鉴权签名（dd.config 用：录音等客户端能力）
 */
router.get(
  '/login/jsapi-sign',
  asyncRoute(async (req, res) => {
    if (!config.dingtalkEnabled) return fail(res, '未配置钉钉应用凭据', 400)
    const url = String(req.query.url || '').split('#')[0]
    if (!/^https?:\/\//.test(url)) return fail(res, 'url 参数无效', 400)
    ok(res, await signJsapi(url))
  }),
)

/**
 * POST /api/login 钉钉免登
 * body: { code, corpId }   钉钉内：JSAPI免登码
 * body: { dev: true }      非钉钉环境：演示登录（需后端未配置钉钉凭据）
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
    } else if (!config.dingtalkEnabled || config.allowDevLogin) {
      // 无免登码场景：未配置凭据=演示模式；已配置但开启访客登录=浏览器测试（真实后端会话）
      user = {
        userId: 'local-guest',
        name: config.dingtalkEnabled ? '浏览器访客' : '演示用户',
        source: 'local',
        isAdmin: true,
      }
    } else {
      return fail(res, '缺少免登授权码，请在钉钉内打开应用')
    }

    const { token, user: userInfo } = createSession(user)
    ok(res, { ...userInfo, token })
  }),
)

export default router
