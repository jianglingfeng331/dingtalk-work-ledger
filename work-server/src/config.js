import 'dotenv/config'

/**
 * 静态环境配置（随部署而定）
 * 运行时可动态调整的配置见 services/settings.js（设置页可改）
 */
export const config = {
  port: Number(process.env.PORT || 3001),

  // 钉钉开放平台企业内部应用凭据
  appKey: process.env.DINGTALK_APP_KEY || '',
  appSecret: process.env.DINGTALK_APP_SECRET || '',
  agentId: process.env.DINGTALK_AGENT_ID || '',
  corpId: process.env.DINGTALK_CORP_ID || '',

  // 未配置钉钉凭据时进入演示模式
  get dingtalkEnabled() {
    return Boolean(this.appKey && this.appSecret)
  },

  // 开发期允许浏览器访客登录（无需免登码，走真实后端会话）
  // 钉钉内始终优先免登；生产公网部署请设 ALLOW_DEV_LOGIN=0 关闭
  allowDevLogin: process.env.ALLOW_DEV_LOGIN !== '0',
}
