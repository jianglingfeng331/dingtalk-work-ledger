import { reactive } from 'vue'
import { login } from '../api'
import { isDingTalkEnv, requestAuthCode } from './dingtalk'
import { loadMyProjects } from './project'

const USER_KEY = 'work_user'
const TOKEN_KEY = 'work_token'

/**
 * 全局用户状态
 * source: 'dingtalk' 钉钉免登 | 'local' 本地演示用户（后端不可用时兜底）
 */
export const userStore = reactive({
  userId: '',
  name: '',
  source: '',
  isAdmin: false,
  ready: false,
})

let initPromise = null

/** 当前会话 token（云端语音转写等直连接口用） */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

/**
 * 强制重新登录（会话自愈用）：服务重启后旧token失效，由请求拦截器在401时调用
 * 并发去重：多个请求同时401只触发一次登录；返回是否拿到了新token
 */
let reloginPromise = null

export function relogin() {
  if (!reloginPromise) {
    const run = async () => {
      const before = localStorage.getItem(TOKEN_KEY)
      initPromise = null
      try {
        await initUser()
      } catch {
        return false
      }
      const after = localStorage.getItem(TOKEN_KEY)
      return Boolean(after) && after !== before
    }
    reloginPromise = run().finally(() => {
      reloginPromise = null
    })
  }
  return reloginPromise
}

/** 初始化用户身份：优先钉钉免登；非钉钉环境走后端演示登录；后端不可用降级本地用户 */
export function initUser() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    // 1. 先恢复本地缓存，避免白屏等待
    try {
      const cached = JSON.parse(localStorage.getItem(USER_KEY) || 'null')
      if (cached?.userId) Object.assign(userStore, cached)
    } catch {
      /* ignore */
    }

    // 2. 登录后端换取正式身份
    const corpId = import.meta.env.VITE_DINGTALK_CORP_ID
    let params = { dev: true }
    let loginOpts = {}
    if (isDingTalkEnv()) {
      if (!corpId) {
        console.error('[user] 钉钉环境但前端未注入 corpId（构建时缺 .env），降级访客登录')
      } else {
        try {
          params = { code: await requestAuthCode(corpId), corpId }
        } catch (err) {
          // 免登码获取失败也记录诊断（SDK加载失败/JSAPI报错/超时）
          console.error('[user] 钉钉免登码获取失败，降级访客登录:', err)
          try {
            localStorage.setItem(
              'last_login_error',
              JSON.stringify({
                time: new Date().toLocaleString(),
                env: 'dingtalk',
                corpId: '已配置',
                msg: `免登码获取失败: ${err?.message || err}`,
              }),
            )
          } catch {
            /* ignore */
          }
          loginOpts = { keepDiag: true } // 降级访客成功后保留免登失败诊断
        }
      }
    }
    try {
      const res = await login(params, loginOpts)
      const info = {
        userId: res.userId || '',
        name: res.name || '未命名用户',
        source: res.source || 'server',
        isAdmin: Boolean(res.isAdmin),
      }
      if (res.token) localStorage.setItem(TOKEN_KEY, res.token)
      Object.assign(userStore, info)
      localStorage.setItem(USER_KEY, JSON.stringify(info))
    } catch (err) {
      console.warn('[user] 后端登录失败，降级为本地用户：', err)
      // 3. 兜底：本地演示用户
      if (!userStore.userId) {
        const guest = { userId: 'local-guest', name: '演示用户', source: 'local', isAdmin: true }
        Object.assign(userStore, guest)
        localStorage.setItem(USER_KEY, JSON.stringify(guest))
      }
    }

    userStore.ready = true
  })()
  return initPromise
}
