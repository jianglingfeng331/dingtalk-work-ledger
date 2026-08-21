/**
 * 自然语言结构化解析（轻量规则版，可升级AI解析）
 * 标签词库由动态配置提供（settings.tags），无需改代码即可扩展
 * 输出字段：任务标题、完成情况（进度）、任务日期、标签、工时
 */
const DONE_RE = /完成|上线|搞定|结束|已处理|已发布|已提测|已交付/
const DOING_RE = /进行|推进|开发中|处理中|跟进|开始|联调|排期|准备/

const pad = (n) => String(n).padStart(2, '0')
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 解析任务执行日期：支持 今天/明天/后天/昨天 及 "X月X日" */
function parseDate(text) {
  const now = new Date()
  const day = 86400000

  if (/昨天/.test(text)) return fmtDate(new Date(now.getTime() - day))
  if (/前天/.test(text)) return fmtDate(new Date(now.getTime() - 2 * day))
  if (/后天/.test(text)) return fmtDate(new Date(now.getTime() + 2 * day))
  if (/明天/.test(text)) return fmtDate(new Date(now.getTime() + day))

  const m = text.match(/(\d{1,2})月(\d{1,2})[日号]/)
  if (m) {
    const date = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
    // 已过去的日期视为去年（如年底记录"1月2日"）
    if (date.getTime() > now.getTime() + 180 * day) date.setFullYear(date.getFullYear() - 1)
    return fmtDate(date)
  }

  return fmtDate(now) // 默认今天
}

/** 提取结构化任务标题：取首个语义分句，剥离开头的时间状语 */
function parseTitle(text) {
  const clause =
    text
      .split(/[，。；;、\n]/)
      .map((s) => s.trim())
      .filter(Boolean)[0] || '未命名任务'

  return clause
    .replace(/^(今天|明天|昨天|后天|上午|下午|晚上|早上|凌晨)\s*/, '')
    .slice(0, 30) || '未命名任务'
}

/**
 * 解析工时（小时）：
 * "3小时" "3.5小时" "3个半小时" "2h" "半小时" "半天" "花了一天/一整天/全天"
 * 注意排除"今天/明天/昨天"等日期词误判；未提及返回 null
 */
function parseHours(text) {
  // X个半小时（如"两个半小时"）
  let m = text.match(/([一二两三四五六七八九\d]+(?:\.\d+)?)个?半小时/)
  if (m) return cnNum(m[1]) + 0.5
  // 半小时
  if (/半小时/.test(text)) return 0.5
  // 半天
  if (/半天/.test(text)) return 4
  // 一天/一整天/全天：需带工时语境（花了/用了/耗时/占用），避免"明天做X"误判
  if (/(?:花|用|耗|花费|占用|干)[了时]?\s*(?:一整?天|1天)|一整天|全天/.test(text)) return 8
  // X小时 / Xh（支持中文数字"三小时"）
  m = text.match(/([一二两三四五六七八九十\d]+(?:\.\d+)?)\s*(?:个)?(?:小时|h|H)/)
  if (m) return cnNum(m[1])
  return null
}

/** 中文数字转数值（无法识别返回 null） */
function cnNum(s) {
  const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const n = cn[s] ?? Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * 结构化解析主入口
 * @param {string} raw 原始口语化内容
 * @param {string[]} tags 动态标签词库
 */
export function parseWorkContent(raw, tags = []) {
  const text = (raw || '').trim()

  let progress = '未开始'
  if (DOING_RE.test(text)) progress = '进行中'
  if (DONE_RE.test(text)) progress = '已完成'

  return {
    title: parseTitle(text),
    progress,
    taskDate: parseDate(text),
    tags: tags.filter((t) => text.includes(t)),
    hours: parseHours(text),
  }
}
