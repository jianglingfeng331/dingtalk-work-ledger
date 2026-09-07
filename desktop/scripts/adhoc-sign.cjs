/**
 * electron-builder afterPack 钩子：对 .app 做 ad-hoc 本地签名。
 *
 * 没有 Apple Developer ID 时，Gatekeeper 会直接把未签名的 .app 移到废纸篓。
 * ad-hoc 签名（codesign --sign -）不需要任何账号或证书，
 * 产出的 .app 在本机和同 macOS 版本上首次打开只需「右键 → 打开」一次，不会被自动删除。
 *
 * 如果后续配置了真实 Apple 证书，electron-builder 会在 afterSign 阶段用正式证书覆盖此签名，
 * 本脚本不再生效（有证书时我们在 package.json 里关掉它）。
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.APPLE_ID || process.env.APPLE_API_KEY) return // 有 Apple 证书时跳过，交给 afterSign 处理

  const appName = context.packager.appInfo.productFilename || '秒建功'
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`[adhoc-sign] 对 ${appPath} 做 ad-hoc 签名...`)
  try {
    // --force: 覆盖已有签名；--deep: 对内部所有二进制签名；--sign -: 用 ad-hoc 本地标识
    execFileSync('codesign', [
      '--force',
      '--deep',
      '--sign', '-',
      '--entitlements', path.join(__dirname, '..', 'build', 'entitlements.mac.plist'),
      '--options', 'runtime',
      appPath,
    ], { stdio: 'inherit' })
    console.log('[adhoc-sign] 完成。Gatekeeper 不会自动删除，首次打开需右键 → 打开。')
  } catch (err) {
    console.warn('[adhoc-sign] 签名失败（可能系统无代码签名工具），继续打包:', err.message)
  }
}
