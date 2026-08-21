import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, getTable } from './settings.js'
import * as table from './dingtalk-table.js'

/**
 * 推送失败补推队列（防网络抖动丢数据）
 * - 日志/计划写入钉钉AI表格失败时入队（按 clientToken 去重），数据先落本地镜像
 * - 定时扫描重推；clientToken 幂等保证"上次其实已成功"的场景不会写出重复行
 * - 队列持久化 data/pending-push.json，服务重启续跑；连续失败保留7天后告警放弃
 */
const QUEUE_FILE = path.join(DATA_DIR, 'pending-push.json')

/** @type {Array<{type:'work'|'plan', clientToken:string, payload:any, createdAt:number, attempts:number, lastError:string}>} */
let queue = []

const SCAN_INTERVAL = 60_000 // 每60秒扫描一轮
const MAX_ATTEMPTS = 200 // 200次×60s≈3.3小时，超过则放弃（记录保留在本地镜像，人工处理）
const RETAIN_MS = 7 * 86400_000

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue))
}

function load() {
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
    if (!Array.isArray(queue)) queue = []
  } catch {
    queue = []
  }
}

/** 入队（按 clientToken 去重：同一记录重复失败不占位） */
export function enqueue({ type, clientToken, payload }) {
  if (!clientToken || queue.some((x) => x.clientToken === clientToken)) return queue.length
  queue.push({ type, clientToken, payload, createdAt: Date.now(), attempts: 0, lastError: '' })
  persist()
  return queue.length
}

/** 队列状态（设置页/诊断用） */
export function pendingStat() {
  return {
    count: queue.length,
    oldest: queue.length ? new Date(Math.min(...queue.map((q) => q.createdAt))).toLocaleString() : '',
    items: queue.map((q) => ({
      type: q.type,
      title: (q.payload?.rawContent || q.payload?.title || '').slice(0, 30),
      attempts: q.attempts,
      lastError: q.lastError,
    })),
  }
}

function dequeue(token) {
  queue = queue.filter((q) => q.clientToken !== token)
  persist()
}

/** 重推单条：日志→工作日志表；计划→任务表。均带 clientToken 幂等；按记录携带的projectId推到对应项目 */
async function repush(item) {
  if (item.type === 'work') {
    await table.addRecord(item.payload, item.payload.unionId || undefined, item.payload.projectId)
    // 动态引入规避循环依赖；镜像清除待补推标记
    const { fixMirrorPushed } = await import('./store.js')
    fixMirrorPushed(item.payload.id)
  } else {
    await table.addPlanRecord(item.payload, undefined, item.clientToken, item.payload.projectId)
  }
}

/** 扫描一轮：表格未启用不推；逐条试推，成功出队；失败 attempts+1 继续等下轮 */
export async function flush() {
  if (!getTable().enabled || !queue.length) return { pushed: 0, left: queue.length }
  let pushed = 0
  for (const item of [...queue]) {
    // 超7天或超次数：放弃（数据仍在本地镜像不丢）
    if (Date.now() - item.createdAt > RETAIN_MS || item.attempts >= MAX_ATTEMPTS) {
      console.warn(`[pending] 放弃补推(${item.type}/${item.clientToken}) 次数${item.attempts}，数据保留本地`)
      dequeue(item.clientToken)
      continue
    }
    try {
      await repush(item)
      dequeue(item.clientToken)
      pushed++
      console.log(`[pending] 补推成功(${item.type}) ${item.clientToken.slice(0, 8)}，剩余${queue.length}条`)
    } catch (err) {
      item.attempts++
      item.lastError = String(err?.response?.data?.message || err?.message || '').slice(0, 100)
    }
  }
  persist()
  return { pushed, left: queue.length }
}

/** 启动补推调度：先清过期，再定时扫描 */
export function startScheduler() {
  load()
  if (queue.length) console.log(`[push] 补推队列载入 ${queue.length} 条待同步记录`)
  setInterval(() => {
    flush().catch((err) => console.warn('[pending] 扫描异常:', err?.message))
  }, SCAN_INTERVAL)
  // 启动30秒后先推一轮（等服务就绪）
  setTimeout(() => {
    flush().catch(() => {})
  }, 30_000)
}
