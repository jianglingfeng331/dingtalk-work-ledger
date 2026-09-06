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
    // 需携带登录态（后端 jsapi-sign 已加鉴权，防为任意来源签名）
    const token = localStorage.getItem('work_token') || ''
    const sign = await fetch(`/api/jsapi-sign?url=${encodeURIComponent(location.href.split('#')[0])}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then((r) => r.json())
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
    this.mediaId = ''
    this.startedAt = 0 // startRecord 成功时刻（过短录音的停止会因原生未生成 mediaId 报错）
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
        this.mediaId = String(res?.mediaId || '')
        this.localId = String(res?.localId || '') || this.mediaId
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
    this.startedAt = Date.now()
  }

  /** 结束录音并转写，返回文本（过短返回 null）；已被自动结束时直接转写 */
  async stopTranscribe() {
    const dd = await ensureJsapiReady()
    // 录音时长过短（如启动竞态瞬间松开）：原生尚未生成媒体数据，此时 stopRecord 会报
    // "The parameter 'mediaId' must not be null"，静默丢弃并按"说话太短"提示
    if (!this.localId && this.startedAt && Date.now() - this.startedAt < 800) {
      try {
        dd.device.audio.stopRecord({ onSuccess: () => {}, onFail: () => {} })
      } catch {
        /* 忽略清理失败 */
      }
      throw new Error('说话时间太短，请重试')
    }
    if (!this.localId) {
      const res = await new Promise((resolve, reject) => {
        dd.device.audio.stopRecord({
          onSuccess: resolve,
          onFail: (err) => {
            const msg = String(err?.errorMessage || err?.message || '')
            reject(new Error(/mediaId/i.test(msg) ? '说话时间太短，请重试' : msg || '结束录音失败'))
          },
        })
      })
      // 不同版本钉钉返回 localId（本地会话标识）或 mediaId（服务端媒体ID）之一或皆有，都记下
      this.localId = String(res?.localId || '')
      this.mediaId = String(res?.mediaId || '')
      this.localId = this.localId || this.mediaId
    }
    if (!this.localId) throw new Error('说话时间太短，请重试')
    const res = await new Promise((resolve, reject) => {
      // 新旧版本钉钉对转写接口的入参名不一致（老版读 localId、新版读 mediaId），两个都传以确保命中
      dd.device.audio.translateVoice({
        localId: this.localId,
        mediaId: this.mediaId || this.localId,
        isShowProgressTips: 0,
        onSuccess: resolve,
        onFail: (err) => {
          const msg = String(err?.errorMessage || err?.message || '')
          console.error('[voice] translateVoice失败:', msg, { localId: this.localId, mediaId: this.mediaId })
          reject(new Error(/mediaId|localId/i.test(msg) ? `录音标识失效(${msg.slice(0, 40)})，请重试` : msg || '语音转写失败，请重试'))
        },
      })
    })
    // 不同版本钉钉返回的文本字段名不一致（新版为 content），多字段兼容读取；为空时把实际字段名暴露出来便于定位
    const text = String(res?.content ?? res?.translateText ?? res?.text ?? res?.result ?? res?.translateResult ?? '').trim()
    console.log('[voice] translateVoice返回字段:', Object.keys(res || {}).join(','), '文本长度:', text.length)
    if (!text) throw new Error(`语音转写为空(${Object.keys(res || {}).join('/') || '空响应'})，请重试`)
    return text
  }

  /** 异常时静默释放（已结束的录音无需清理） */
  async abort() {
    try {
      const dd = await ensureJsapiReady()
      if (!this.localId) dd.device.audio.stopRecord({ onSuccess: () => {}, onFail: () => {} })
    } catch { /* 忽略 */ }
  }
}
