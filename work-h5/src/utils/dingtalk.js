/**
 * 钉钉 JSAPI 免登工具
 * 说明：仅在钉钉客户端内打开时生效；普通浏览器/微信中自动跳过，走本地演示用户。
 */
const SDK_URL = 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js'

/** 是否在钉钉容器内 */
export function isDingTalkEnv() {
  return /DingTalk/i.test(navigator.userAgent)
}

let sdkPromise = null

function loadSDK() {
  if (window.dd) return Promise.resolve(window.dd)
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SDK_URL
    script.onload = () => resolve(window.dd)
    script.onerror = () => reject(new Error('钉钉 JSAPI 加载失败'))
    document.head.appendChild(script)
  })
  return sdkPromise
}

/**
 * 获取免登授权码（code），交给后端换取用户身份
 * @param {string} corpId 企业 CorpId（.env 中 VITE_DINGTALK_CORP_ID）
 */
export async function requestAuthCode(corpId) {
  const dd = await loadSDK()
  return new Promise((resolve, reject) => {
    // 8s 超时保护：JSAPI 无响应时明确报错而非挂死
    const timer = setTimeout(() => reject(new Error('免登码获取超时(8s)，请重试')), 8000)
    dd.ready(() => {
      dd.runtime.permission.requestAuthCode({
        corpId,
        onSuccess: (res) => {
          clearTimeout(timer)
          res?.code ? resolve(res.code) : reject(new Error('免登码为空'))
        },
        onFail: (err) => {
          clearTimeout(timer)
          reject(new Error(err?.errorMessage || err?.message || JSON.stringify(err) || '获取免登码失败'))
        },
      })
    })
    dd.error((err) => {
      clearTimeout(timer)
      reject(new Error(`JSAPI鉴权错误: ${err?.message || JSON.stringify(err)}`))
    })
  })
}

/* ============ JSAPI 录音（钉钉容器内，浏览器录音 API 不可用时的兜底） ============ */

const AUDIO_APIS = ['device.audio.startRecord', 'device.audio.stopRecord', 'device.audio.onRecordEnd', 'device.audio.translateVoice']

let jsapiReady = null

/** dd.config 鉴权（一次会话内只做一次；录音等客户端能力必须鉴权） */
export function ensureJsapiReady() {
  if (jsapiReady) return jsapiReady
  jsapiReady = (async () => {
    const dd = await loadSDK()
    const sign = await fetch(`/api/login/jsapi-sign?url=${encodeURIComponent(location.href.split('#')[0])}`).then((r) => r.json())
    if (sign?.code !== 0) throw new Error(sign?.message || 'JSAPI签名获取失败')
    const { agentId, corpId, timeStamp, nonceStr, signature } = sign.data
    return new Promise((resolve, reject) => {
      dd.config({ agentId, corpId, timeStamp, nonceStr, signature, jsApiList: AUDIO_APIS, type: 0 })
      dd.ready(() => resolve(dd))
      dd.error((err) => reject(new Error(`JSAPI鉴权失败: ${err?.message || '签名可能过期，请刷新重试'}`)))
    })
  })().catch((err) => {
    jsapiReady = null // 失败允许下次重试
    throw err
  })
  return jsapiReady
}

/**
 * 钉钉 JSAPI 录音会话：start 开始，stop 结束并用钉钉自带转写返回文本
 * 适配场景：webview 无 getUserMedia/MediaRecorder（HTTP 非安全上下文的老安卓内核）
 */
export class DdAudioRecorder {
  constructor() {
    this.localId = ''
    this.onAutoEnd = null // 录音达60秒上限被钉钉自动结束时的回调（外层用于补转写）
  }

  static supported() {
    return isDingTalkEnv()
  }

  async start() {
    const dd = await ensureJsapiReady()
    // 先注册自动结束监听：达到 maxDuration 钉钉会自动结束并回调，此时再调 stopRecord 会失败，
    // 因此把回调里的 localId 记下，stopTranscribe 直接复用
    dd.device.audio.onRecordEnd({
      onSuccess: (res) => {
        if (this.localId) return // 已被正常 stopRecord 结束
        this.localId = res?.mediaId || res?.localId || ''
        this.onAutoEnd?.()
      },
      onFail: () => {},
    })
    await new Promise((resolve, reject) => {
      dd.device.audio.startRecord({
        maxDuration: 60,
        onSuccess: resolve,
        onFail: (err) => reject(new Error(err?.errorMessage || err?.message || '启动录音失败')),
      })
    })
  }

  /** 结束录音并转写，返回文本（过短返回 null）；已被自动结束时直接转写 */
  async stopTranscribe() {
    const dd = await ensureJsapiReady()
    if (!this.localId) {
      this.localId = await new Promise((resolve, reject) => {
        dd.device.audio.stopRecord({
          onSuccess: (res) => resolve(res?.mediaId || res?.localId || ''),
          onFail: (err) => reject(new Error(err?.errorMessage || err?.message || '结束录音失败')),
        })
      })
    }
    if (!this.localId) throw new Error('录音数据为空，请重试')
    const { translateText } = await new Promise((resolve, reject) => {
      dd.device.audio.translateVoice({
        localId: this.localId,
        isShowProgressTips: 0,
        onSuccess: resolve,
        onFail: (err) => reject(new Error(err?.errorMessage || err?.message || '语音转写失败，请重试')),
      })
    })
    const text = String(translateText || '').trim()
    return text || null
  }

  /** 异常时静默释放（已结束的录音无需清理） */
  async abort() {
    try {
      const dd = await ensureJsapiReady()
      if (!this.localId) dd.device.audio.stopRecord({ onSuccess: () => {}, onFail: () => {} })
    } catch { /* 忽略 */ }
  }
}
