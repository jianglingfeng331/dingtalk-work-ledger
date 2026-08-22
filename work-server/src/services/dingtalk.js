import axios from 'axios'
import crypto from 'node:crypto'
import { config } from '../config.js'

/**
 * 钉钉开放平台服务：access_token 缓存 + 免登码换用户信息 + JSAPI 鉴权签名
 */
const HTTP = axios.create({ timeout: 10000 })

let tokenCache = { token: '', expireAt: 0 }
let ticketCache = { ticket: '', expireAt: 0 }

/** 获取企业 access_token（长期缓存，提前5分钟刷新） */
export async function getAccessToken() {
  if (!config.dingtalkEnabled) throw new Error('未配置钉钉应用凭据')
  if (tokenCache.token && Date.now() < tokenCache.expireAt) return tokenCache.token

  const { data } = await HTTP.post('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    appKey: config.appKey,
    appSecret: config.appSecret,
  })
  if (!data?.accessToken) throw new Error('获取钉钉access_token失败')

  tokenCache = {
    token: data.accessToken,
    expireAt: Date.now() + (data.expireInMs || 7200_000) - 5 * 60_000,
  }
  return tokenCache.token
}

/** 获取企业 jsapi_ticket（JSAPI 鉴权用，长期缓存） */
export async function getJsapiTicket() {
  if (ticketCache.ticket && Date.now() < ticketCache.expireAt) return ticketCache.ticket
  const token = await getAccessToken()
  const { data } = await HTTP.get(`https://oapi.dingtalk.com/get_jsapi_ticket?access_token=${token}`)
  if (data?.errcode !== 0 || !data?.ticket) throw new Error(`获取jsapi_ticket失败: ${data?.errmsg || '未知'}`)
  ticketCache = {
    ticket: data.ticket,
    expireAt: Date.now() + (data.expire_in || 7200) * 1000 - 5 * 60_000,
  }
  return ticketCache.ticket
}

/**
 * 生成 JSAPI 鉴权签名（dd.config 用，录音等客户端能力必须鉴权）
 * @param {string} url 当前页面 URL（去掉 hash）
 */
export async function signJsapi(url) {
  const ticket = await getJsapiTicket()
  const nonceStr = crypto.randomBytes(8).toString('hex')
  const timeStamp = String(Math.floor(Date.now() / 1000))
  const plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`
  const signature = crypto.createHash('sha1').update(plain).digest('hex')
  return { agentId: config.agentId, corpId: config.corpId, timeStamp, nonceStr, signature }
}

/**
 * 免登授权码 → 用户信息（userid + 姓名）
 * 姓名拉取失败（应用缺「通讯录个人信息读权限」等）不阻断登录，降级用 userid 标识
 */
export async function getUserByAuthCode(code) {
  const token = await getAccessToken()

  // 1. 通过免登码换取 userid
  const { data: infoRes } = await HTTP.post(
    `https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${token}`,
    { code },
  )
  if (infoRes.errcode !== 0) {
    throw new Error(`免登码换用户失败(${infoRes.errcode}): ${infoRes.errmsg}`)
  }
  const userid = infoRes.result?.userid
  if (!userid) throw new Error('免登失败: 未获取到用户')

  // 2. 拉取用户详情（姓名 + unionId；AI表格API的 operatorId 必填 unionId；失败仅降级，不影响登录）
  let name = ''
  let unionId = ''
  const fetchDetail = async (fieldList) => {
    const { data } = await HTTP.post(
      `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${token}`,
      { userid, fieldList },
    )
    return data
  }
  try {
    let userRes = await fetchDetail(['name', 'unionId'])
    // fieldList 不支持 unionId 时降级只取姓名
    if (userRes.errcode !== 0) userRes = await fetchDetail(['name'])
    if (userRes.errcode === 0) {
      name = userRes.result?.name || ''
      unionId = userRes.result?.unionid || userRes.result?.unionId || ''
    } else {
      console.warn(`[dingtalk] 拉取用户详情失败(${userRes.errcode}): ${userRes.errmsg}，请检查应用「通讯录个人信息读权限」`)
    }
  } catch (err) {
    console.warn('[dingtalk] 拉取用户详情异常:', err?.message)
  }

  // 3. unionId 兜底：v2 详情未返回时走专用接口换取
  if (!unionId) {
    try {
      const { data: uRes } = await HTTP.post(
        `https://oapi.dingtalk.com/topapi/user/getUnionId?access_token=${token}`,
        { userid },
      )
      if (uRes.errcode === 0) unionId = uRes.result || ''
    } catch (err) {
      console.warn('[dingtalk] 拉取unionId异常:', err?.message)
    }
  }

  return {
    userId: userid,
    unionId,
    name: name || `钉钉用户-${userid.slice(-4)}`,
    source: 'dingtalk',
  }
}
