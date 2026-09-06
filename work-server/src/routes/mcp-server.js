import { Router } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { getUserByToken } from '../services/session.js'
import { isAdmin, listProjects, matchProjectByText } from '../services/settings.js'
import { callTool } from '../services/mcp.js'
import { runAiQuery, AiQueryError } from '../services/ai-query.js'
import {
  normalize,
  l1Get,
  l1Set,
  semGet,
  semSet,
  tryAcquireAi,
  recordAiResult,
  allowUser,
  countRequest,
  countToolCall,
  observe,
  metricsText,
  healthInfo,
} from '../services/mcp-cache.js'

/**
 * MCP（Model Context Protocol）服务端点 —— 挂载到 work-server 同进程 /mcp 路径
 * 传输：Streamable HTTP（无状态模式，每请求独立 server+transport，天然支持水平扩展）
 * 鉴权：Bearer <token>
 *   - MCP_AUTH_TOKEN 环境变量 → 服务账号（admin 权限，供 AI 客户端/网关接入）
 *   - 应用会话 token → 真实用户（权限与 H5 一致：非管理员看不到团队数据）
 * 性能：三级缓存（L1 精确 → 语义向量 → AI 直答）+ 并发信号量 + 熔断 + 每用户限流
 */

const router = Router()

const TOOL_TTL = 60_000 // 数据类工具 L1 缓存 60s
const AI_L1_TTL = 5 * 60_000 // AI 答案精确缓存 5 分钟
const AI_SEM_TTL = 30 * 60_000 // AI 答案语义缓存 30 分钟

/* ============ 鉴权 ============ */

function resolveUser(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null

  // 服务账号：MCP_AUTH_TOKEN（AI 客户端接入用，admin 权限）
  const svcToken = process.env.MCP_AUTH_TOKEN || ''
  if (svcToken && token === svcToken) {
    return { userId: 'mcp-service', name: 'MCP服务账号', source: 'mcp', isAdmin: true, projectId: resolveProjectId(req) }
  }

  // 应用会话：与 H5 相同的用户身份与实时管理员判定
  const user = getUserByToken(token)
  if (!user) return null
  user.isAdmin = isAdmin(user.userId, user.source)
  user.projectId = resolveProjectId(req)
  return user
}

/** 项目上下文：x-project-id 头或 ?projectId= 查询参数（支持项目别名，如"城投ai项目"），缺省取第一个项目 */
function resolveProjectId(req) {
  const fromHeader = String(req.headers['x-project-id'] || '').trim()
  if (fromHeader) return fromHeader
  const fromQuery = String(req.query?.projectId || '').trim()
  if (fromQuery) {
    // 传的是别名（如 ?projectId=ai协同项目）时解析为真实项目ID
    const hit = matchProjectByText(fromQuery)
    if (hit) return hit.id
    return fromQuery
  }
  return String(listProjects()[0]?.id || '')
}

function authMcp(req, res, next) {
  const user = resolveUser(req)
  if (!user) {
    res.setHeader('WWW-Authenticate', 'Bearer')
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: '未授权：请在 Authorization 头携带 Bearer <MCP_AUTH_TOKEN 或应用会话token>' }, id: null })
  }
  req.user = user
  next()
}

/* ============ 工具实现（缓存包裹） ============ */

/** 数据类工具：L1 缓存 60s，key 绑定用户身份与查询参数 */
async function cachedToolCall(user, name, params) {
  countToolCall()
  const key = `tool:${name}:${user.userId}:${user.isAdmin ? 1 : 0}:${user.projectId}:${normalize(JSON.stringify(params))}`
  const hit = l1Get(key)
  if (hit !== undefined) return { result: hit, cached: true }
  const result = await callTool(name, { user, ...params })
  l1Set(key, result, TOOL_TTL)
  return { result, cached: false }
}

/** ai_query：三级缓存 + 并发防护 */
async function aiQueryCached(user, question) {
  countToolCall()
  if (!allowUser(user.userId)) {
    throw new AiQueryError('请求过于频繁（限流 30 次/分钟），请稍后再试', 'rate_limited')
  }

  const l1Key = `aiq:${user.userId}:${user.isAdmin ? 1 : 0}:${user.projectId}:${normalize(question)}`
  const l1Hit = l1Get(l1Key)
  if (l1Hit !== undefined) return { ...l1Hit, cached: 'l1' }

  const ns = `aiq:${user.userId}:${user.projectId}`
  const semHit = await semGet(ns, question)
  if (semHit !== undefined) return { answer: semHit, scope: 'personal', cached: 'semantic' }

  // AI 并发信号量 + 熔断快速失败
  const slot = tryAcquireAi()
  if (!slot.ok) {
    throw new AiQueryError(
      slot.reason === 'breaker-open' ? 'AI 服务暂时不可用（熔断保护中），请稍后再试' : 'AI 查询繁忙，请稍后再试',
      slot.reason,
    )
  }
  const start = Date.now()
  try {
    const out = await runAiQuery(user, question)
    recordAiResult(true)
    l1Set(l1Key, out, AI_L1_TTL)
    semSet(ns, question, out.answer, AI_SEM_TTL).catch(() => {})
    return { ...out, cached: false }
  } catch (err) {
    recordAiResult(false)
    throw err
  } finally {
    slot.release()
    observe(Date.now() - start)
  }
}

/* ============ MCP Server 工厂（每请求实例，闭包绑定用户做 RBAC） ============ */

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }
}

/** initialize 指令说明（skill 的"指令标准"）：项目别名映射 + 按表路由指南，AI客户端（含语音/眼镜端）据此选工具 */
function buildInstructions() {
  const ps = listProjects()
  const projLines = ps
    .map((p) => `- ${p.name}（ID: ${p.id}）${p.aliases?.length ? `，也叫/别名：${p.aliases.join('、')}` : ''}`)
    .join('\n')
  return [
    '这是项目工作台账查询服务。用户可能用各种口语化叫法提到项目，均按下表映射（如"城投ai项目""ai协同项目"都指城投AI协同）：',
    projLines || '（暂无项目）',
    '',
    '【工具路由标准——按问题涉及的数据表选工具，数据类工具秒级返回，优先使用】',
    '- 问任务/工作安排/谁负责什么/任务进度 → get_tasks（任务表）',
    '- 问领导指令/领导交办/办结时限/指令进展 → get_directives（领导指令表）',
    '- 问项目成员/有哪些人/角色分工 → get_members（项目成员表）',
    '- 问工作日志/今天干了什么/本周提交了什么/工时 → get_work_records（工作日志表）或 get_work_stats（统计）',
    '- 仅当需要跨表综合分析、归纳总结时才用 ai_query（深度分析，需30-60秒，语音/眼镜等短超时客户端请勿使用）',
    '',
    '回答用简洁中文，列数据时按「条目-负责人-状态-时限」一行一条。',
  ].join('\n')
}

function createMcpServer(user) {
  const server = new McpServer(
    { name: 'work-ledger-mcp', version: '1.0.0' },
    { capabilities: { logging: {} }, instructions: buildInstructions() },
  )

  server.registerTool(
    'ai_query',
    {
      title: 'AI 智能查询',
      description:
        '深度分析查询（慢，需30-60秒，语音/眼镜等短超时客户端勿用）：跨工作日志、任务、指令、成员综合分析。简单事实查询请优先用 get_tasks/get_directives/get_members/get_work_records（秒级）。支持「团队本周工作汇总」「张三的工时分析」等复杂问法',
      inputSchema: { question: z.string().min(1).describe('自然语言问题，如：本周完成了哪些任务？') },
    },
    async ({ question }) => {
      // 问题中提到项目名/别名（如"ai项目里还有多少活"）→ 切换到该项目上下文
      const hit = matchProjectByText(question)
      const qUser = hit && hit.id !== user.projectId ? { ...user, projectId: hit.id } : user
      const out = await aiQueryCached(qUser, question)
      const prefix = out.cached === 'l1' ? '[cache:exact] ' : out.cached === 'semantic' ? '[cache:semantic] ' : ''
      return textResult(prefix + out.answer)
    },
  )

  server.registerTool(
    'get_work_records',
    {
      title: '查询工作日志',
      description: '查工作日志表（秒级返回）：谁在何日提交了什么工作内容、完成情况、工时。问「今天干了什么」「本周提交了哪些日志」「张三的工时」用这个',
      inputSchema: {
        scope: z.enum(['all', 'today', 'week', 'undone']).optional().describe('查询范围，默认 all'),
        team: z.boolean().optional().describe('是否查询全员数据（仅管理员生效）'),
      },
    },
    async (params = {}) => textResult(await cachedToolCall(user, 'get_work_records', params)),
  )

  server.registerTool(
    'get_work_stats',
    {
      title: '台账统计',
      description: '工作台账统计概览（秒级返回）：记录数、完成率、进度分布、各成员工作量。问「完成率」「谁干得最多」用这个',
      inputSchema: { team: z.boolean().optional().describe('是否统计全员数据（仅管理员生效）') },
    },
    async (params = {}) => textResult(await cachedToolCall(user, 'get_work_stats', params)),
  )

  server.registerTool(
    'get_tasks',
    {
      title: '查询任务表',
      description: '查任务表（秒级返回）：任务名、负责人、状态、计划节点、分类。问「有哪些任务」「谁负责什么」「未完成的任务」用这个',
      inputSchema: { owner: z.string().optional().describe('按负责人姓名过滤') },
    },
    async (params = {}) => textResult(await cachedToolCall(user, 'get_tasks', params)),
  )

  server.registerTool(
    'get_members',
    {
      title: '查询项目成员',
      description: '查项目成员表（秒级返回）：成员姓名与角色。问「项目有哪些人」「成员角色分工」用这个',
      inputSchema: {},
    },
    async () => textResult(await cachedToolCall(user, 'get_members', {})),
  )

  server.registerTool(
    'get_directives',
    {
      title: '查询领导指令',
      description: '查领导指令表（秒级返回）：领导下达的任务指令，含负责人、办结时限、状态、执行进展。问「领导下了哪些指令」「未完成的指令」「指令进展」用这个',
      inputSchema: {
        status: z.enum(['未开始', '进行中', '已完成', '已延期']).optional().describe('按状态过滤'),
      },
    },
    async (params = {}) => textResult(await cachedToolCall(user, 'get_directives', params)),
  )

  return server
}

/* ============ 路由 ============ */

// 协议端点（无状态模式：每请求独立 server + transport）
router.post('/', authMcp, async (req, res) => {
  countRequest()
  try {
    const server = createMcpServer(req.user)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    console.error('[mcp] 请求处理失败:', err?.message)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP 服务内部错误' }, id: null })
    }
  }
})

// 无状态模式不支持 SSE 长连接与会话终止
router.get('/', (req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: '无状态模式不支持 GET（SSE）' }, id: null }))
})
router.delete('/', (req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: '无状态模式不支持 DELETE' }, id: null }))
})

// 健康检查（公开，供网关/监控探活）
router.get('/health', (req, res) => {
  res.json({
    status: 'up',
    service: 'work-ledger-mcp',
    transport: 'streamable-http (stateless)',
    tools: 6,
    auth: process.env.MCP_AUTH_TOKEN ? 'token+session' : 'session',
    time: new Date().toISOString(),
    ...healthInfo(),
  })
})

// 运行指标（Prometheus 文本；限本机或携带有效凭证）
router.get('/metrics', (req, res) => {
  const local = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1|localhost)/.test(req.ip || '')
  if (!local && !resolveUser(req)) {
    return res.status(401).send('unauthorized')
  }
  res.type('text/plain; version=0.0.4').send(metricsText())
})

export default router
