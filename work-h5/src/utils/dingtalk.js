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
