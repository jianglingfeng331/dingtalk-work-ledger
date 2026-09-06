/**
 * electron-builder afterSign 钩子：macOS 签名完成后自动提交 Apple 公证并装订票据。
 *
 * 凭证全部从环境变量读取，切勿在此文件中硬编码账号/密码：
 *   Apple ID 方式：
 *     APPLE_ID                        Apple ID 账号（邮箱）
 *     APPLE_APP_SPECIFIC_PASSWORD     在 appleid.apple.com 生成的 App 专用密码
 *     APPLE_TEAM_ID                   团队 ID（10 位，钥匙串证书名括号内可查）
 *   API Key 方式（可选，二选一）：
 *     APPLE_API_KEY                   .p8 密钥文件路径
 *     APPLE_API_KEY_ID                密钥 ID
 *     APPLE_API_ISSUER                Issuer ID
 *
 * 未配置任何凭证时自动跳过公证（不阻断本地构建）。
 */
const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`

  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID

  const appleApiKey = process.env.APPLE_API_KEY
  const appleApiKeyId = process.env.APPLE_API_KEY_ID
  const appleApiIssuer = process.env.APPLE_API_ISSUER

  const hasAppleId = appleId && appleIdPassword && teamId
  const hasApiKey = appleApiKey && appleApiKeyId && appleApiIssuer

  if (!hasAppleId && !hasApiKey) {
    console.warn(
      '[notarize] 未检测到公证凭证（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID），跳过公证。' +
        '注意：未公证的包分发给他人仍会被 Gatekeeper 拦截。'
    )
    return
  }

  const options = { tool: 'notarytool', appPath }
  if (hasApiKey) {
    Object.assign(options, { appleApiKey, appleApiKeyId, appleApiIssuer })
    console.log(`[notarize] 使用 API Key 凭证提交公证：${appPath}`)
  } else {
    Object.assign(options, { appleId, appleIdPassword, teamId })
    console.log(`[notarize] 使用 Apple ID 凭证提交公证：${appPath}`)
  }

  console.log('[notarize] 正在上传到 Apple 公证服务，通常需要 3-10 分钟，请耐心等待...')
  // notarize() 成功后会自动执行 xcrun stapler staple 装订离线票据
  await notarize(options)
  console.log('[notarize] 完成，公证通过且票据已自动装订。')
}
