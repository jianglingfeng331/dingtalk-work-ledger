const pad = (n) => String(n).padStart(2, '0')

/** 格式化为 YYYY-MM-DD */
export function fmtDate(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 格式化为 YYYY-MM-DD HH:mm */
export function fmtDateTime(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d)
  return `${fmtDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 判断日期字符串是否在最近 N 天内（含今天） */
export function withinDays(dateStr, days) {
  const t = new Date(String(dateStr).replace(/-/g, '/')).getTime()
  if (Number.isNaN(t)) return false
  const diff = (Date.now() - t) / 86400000
  return diff >= 0 && diff < days
}
