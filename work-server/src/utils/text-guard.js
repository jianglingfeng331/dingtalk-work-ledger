/**
 * 文本合法性校验：拦住异常编码的脏文本，防止写入钉钉AI表格变成乱码
 * 背景：个别安卓设备（特定输入法/webview）发出的请求体中文编码异常，
 * express 按 JSON 解析后中文变成 U+FFFD 替换符，写入表格即 "����"，
 * 且钉钉单选列会自动新建乱码选项污染表结构。
 */

/** 控制字符（不含 \t \n \r）：出现即视为异常编码 */
const CTRL = /[\u0000-\u0008\u000E-\u001F\u007F]/

/**
 * 检测文本是否为异常编码
 * @returns {string|null} 异常原因描述；null=正常
 */
export function mojibakeReason(s) {
  const t = String(s || '')
  if (!t) return null
  if (t.includes('\uFFFD')) return '包含乱码替换符(U+FFFD)'
  if (CTRL.test(t)) return '包含控制字符'
  return null
}

/** 校验并返回错误消息；正常返回 null。hitLog 用于记录问题请求来源（定位问题设备） */
export function checkText(s, field, user) {
  const reason = mojibakeReason(s)
  if (!reason) return null
  if (user) {
    console.warn(
      `[text-guard] 拦截异常编码: user=${user.userId}(${user.name}) field=${field} ${reason} 内容片段=${JSON.stringify(String(s).slice(0, 40))}`,
    )
  }
  return `提交的${field}${reason}，可能是设备或输入法编码异常，请重新输入后再试；若持续出现，请尝试切换输入法或重启应用`
}
