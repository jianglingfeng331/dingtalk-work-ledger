import axios from 'axios'
import { config } from '../config.js'

/**
 * 钉钉开放平台服务：access_token 缓存 + 免登码换用户信息
 */
const HTTP = axios.create({ timeout: 10000 })

let tokenCache = { token: '', expireAt: 0 }

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
