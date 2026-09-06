import { getAI } from './settings.js'

/**
 * MCP 缓存与运行指标（进程内存实现，轻量无外部依赖）
 * - L1 精确缓存：规范化 key 命中，毫秒级返回
 * - 语义缓存：仅 AI 问答；问题向量相似度 ≥ 阈值即复用历史答案（换种问法不用重新推理）
 * - 指标计数 + 最近请求时长环形采样（/mcp/metrics 暴露 Prometheus 文本）
 */

const L1_MAX = 2000
const SEM_MAX = 5000
const EMB_TTL = 30 * 60_000
const SIM_THRESHOLD = 0.92
const DURATION_RING = 100

const l1 = new Map() // key -> { v, exp }
const sem = new Map() // ns -> [{ key, vec, v, exp }]（同命名空间小数组线性扫描，量级≤5000足够）
const embCache = new Map() // 规范化问题 -> { v: Float32Array, exp }

const metrics = {
  requests: 0,
  toolCalls: 0,
  l1Hits: 0,
  semHits: 0,
  aiCalls: 0,
  aiErrors: 0,
  rejects: 0,
  durations: [],
}

/* ============ 文本规范化（缓存 key 稳定性） ============ */

const FULL2HALF = (s) =>
  s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ')

export function normalize(text) {
  return FULL2HALF(String(text || ''))
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

/* ============ L1 精确缓存 ============ */

export function l1Get(key) {
  const hit = l1.get(key)
  if (!hit) return undefined
  if (hit.exp < Date.now()) {
    l1.delete(key)
    return undefined
  }
  metrics.l1Hits++
  return hit.v
}

export function l1Set(key, value, ttlMs) {
  if (l1.size >= L1_MAX) l1.delete(l1.keys().next().value) // FIFO 淘汰
  l1.set(key, { v: value, exp: Date.now() + ttlMs })
}

/* ============ 语义缓存（仅 AI 问答） ============ */

const DICE_THRESHOLD = 0.6 // 字符二元组 Dice 阈值（embedding 不可用时的本地兜底，偏保守防误命中）

let embedFailUntil = 0 // embedding 连续失败（限流/无资源包）后的冷却期，期间不再外呼

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/** 字符二元组 Dice 相似度（本地，零依赖）：捕获语序调换/增删一两词的重复问法 */
function diceBigram(a, b) {
  if (a === b) return 1
  const grams = (s) => {
    const g = new Set()
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2))
    return g
  }
  const ga = grams(a)
  const gb = grams(b)
  if (!ga.size || !gb.size) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return (2 * inter) / (ga.size + gb.size)
}

/** 问题向量化（智谱 embedding-3，OpenAI 兼容）；失败/未配置/冷却中返回 null → 退化为本地 Dice 相似度 */
async function embed(question) {
  const ai = getAI()
  if (!ai.enabled || ai.provider !== 'zhipu') return null
  if (Date.now() < embedFailUntil) return null
  const norm = normalize(question)
  const cached = embCache.get(norm)
  if (cached) return cached.exp < Date.now() ? (embCache.delete(norm), null) : cached.v
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`${ai.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embedding-3', input: norm }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      // 429/403：限流或无资源包（智谱1113）→ 冷却10分钟，避免每次查询都白打一次外部请求
      if (res.status === 429 || res.status === 403) embedFailUntil = Date.now() + 10 * 60_000
      return null
    }
    const data = await res.json()
    const vec = data?.data?.[0]?.embedding
    if (!Array.isArray(vec)) return null
    const arr = Float32Array.from(vec)
    if (embCache.size >= 500) embCache.delete(embCache.keys().next().value)
    embCache.set(norm, { v: arr, exp: Date.now() + EMB_TTL })
    return arr
  } catch {
    return null
  }
}

/** 语义命中：返回相似历史答案或 undefined（向量余弦优先，不可用退化为 bigram Dice） */
export async function semGet(namespace, question) {
  const norm = normalize(question)
  const vec = await embed(norm)
  const list = sem.get(namespace)
  if (!list?.length) return undefined
  const now = Date.now()
  let best = null
  let bestSim = 0
  for (const item of list) {
    if (item.exp < now) continue
    const useVec = vec && item.vec
    const sim = useVec ? cosine(vec, item.vec) : diceBigram(norm, item.key)
    if (sim > bestSim) {
      bestSim = sim
      best = item
    }
  }
  const threshold = vec && best?.vec ? SIM_THRESHOLD : DICE_THRESHOLD
  if (best && bestSim >= threshold) {
    metrics.semHits++
    return best.v
  }
  return undefined
}

export async function semSet(namespace, question, value, ttlMs) {
  const norm = normalize(question)
  const vec = await embed(norm) // 可能为 null（冷却中/未配置），此时条目仅用 bigram 匹配
  const list = sem.get(namespace) || []
  list.push({ key: norm, vec, v: value, exp: Date.now() + ttlMs })
  while (list.length > SEM_MAX) list.shift()
  sem.set(namespace, list)
}

/* ============ AI 并发信号量 + 熔断器 ============ */

let inflightAi = 0
const MAX_INFLIGHT_AI = 50
const breaker = { calls: [], openUntil: 0 } // 最近调用结果环形记录

export function tryAcquireAi() {
  if (Date.now() < breaker.openUntil) return { ok: false, reason: 'breaker-open' }
  if (inflightAi >= MAX_INFLIGHT_AI) return { ok: false, reason: 'busy' }
  inflightAi++
  return { ok: true, release: () => inflightAi--, }
}

export function recordAiResult(ok) {
  if (ok) metrics.aiCalls++
  else metrics.aiErrors++
  breaker.calls.push({ t: Date.now(), ok })
  if (breaker.calls.length > 40) breaker.calls.shift()
  // 最近 20 次失败率 ≥50% → 熔断 15 秒（期间直接快速拒绝，保护上游与队列）
  const recent = breaker.calls.slice(-20)
  if (recent.length >= 20 && recent.filter((c) => !c.ok).length / recent.length >= 0.5) {
    breaker.openUntil = Date.now() + 15_000
    breaker.calls = []
    console.warn('[mcp] AI 错误率过高，熔断 15 秒')
  }
}

export const isBreakerOpen = () => Date.now() < breaker.openUntil

/* ============ 每用户限流（令牌桶：30 发 / 每分钟补 30） ============ */

const buckets = new Map()
export function allowUser(userId, cost = 1) {
  const now = Date.now()
  const b = buckets.get(userId) || { tokens: 30, ts: now }
  b.tokens = Math.min(30, b.tokens + ((now - b.ts) / 60_000) * 30)
  b.ts = now
  if (b.tokens < cost) {
    buckets.set(userId, b)
    metrics.rejects++
    return false
  }
  b.tokens -= cost
  buckets.set(userId, b)
  return true
}

/* ============ 指标 ============ */

export function countRequest() {
  metrics.requests++
}

export function countToolCall() {
  metrics.toolCalls++
}

export function observe(durationMs) {
  metrics.durations.push(durationMs)
  if (metrics.durations.length > DURATION_RING) metrics.durations.shift()
}

function pct(arr, p) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))])
}

export function metricsText() {
  const m = metrics
  const d = m.durations
  return [
    '# HELP mcp_requests_total Total MCP requests',
    '# TYPE mcp_requests_total counter',
    `mcp_requests_total ${m.requests}`,
    '# TYPE mcp_tool_calls_total counter',
    `mcp_tool_calls_total ${m.toolCalls}`,
    '# TYPE mcp_cache_hits_total counter',
    `mcp_cache_hits_total{l1="${m.l1Hits}",semantic="${m.semHits}"}`,
    '# TYPE mcp_ai_calls_total counter',
    `mcp_ai_calls_total{ok="${m.aiCalls}",err="${m.aiErrors}"} ${m.aiCalls + m.aiErrors}`,
    '# TYPE mcp_rejects_total counter',
    `mcp_rejects_total ${m.rejects}`,
    '# TYPE mcp_duration_ms gauge',
    `mcp_duration_ms{quantile="0.95"} ${pct(d, 95)}`,
    `mcp_duration_ms{quantile="0.99"} ${pct(d, 99)}`,
  ].join('\n')
}

export function healthInfo() {
  return {
    l1Entries: l1.size,
    semanticNamespaces: sem.size,
    inflightAi,
    breakerOpen: isBreakerOpen(),
    uptimeSec: Math.round(process.uptime()),
  }
}

/* ============ 失效（数据写入时调用，保证新鲜度） ============ */

export function invalidateMcpCache() {
  l1.clear()
  sem.clear()
}
