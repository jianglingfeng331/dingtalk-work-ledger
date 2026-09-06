import { Router } from 'express'
import { runAiQuery, AiQueryError } from '../services/ai-query.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

/**
 * POST /api/ai-query AI 智能查询
 * 默认 SSE 流式（?stream=0 或 body.stream===false 时返回普通 JSON，供前端降级）
 * SSE 响应为 text/event-stream，事件均为 `data: {json}\n\n`：
 *   {type:'token', content:string}  模型增量输出（逐字）
 *   {type:'done',  answer:string, scope:'personal'|'team'}  完整回答结束
 *   {type:'error', message:string} 失败
 * 数据就绪前每 1.5s 发送 `: ping` 注释行保活：MCP 拉台账数据需数秒静默，
 * 部分客户端（钉钉 webview 等）会因空闲超时掐断无字节的流（实测 3.8~15.8s 断连）
 * 核心管线在 services/ai-query.js（与 MCP ai_query 工具共用同一实现）
 */
router.post(
  '/ai-query',
  asyncRoute(async (req, res) => {
    const question = String(req.body?.question || '').trim()
    if (!question) return fail(res, '问题不能为空')

    const t0 = Date.now()
    let tokenCount = 0
    console.log(`[ai-query] 收到请求: ${question.slice(0, 30)}${req.query?.stream === '0' ? ' (非流式)' : ''}`)

    // 非流式降级：一次性返回完整答案（前端在流式失败时自动切换，走原稳定链路）
    if (req.query?.stream === '0') {
      try {
        const { answer, scope } = await runAiQuery(req.user, question, { budgetMs: 75_000 })
        console.log(`[ai-query] 完成(非流式): ${Date.now() - t0}ms`)
        return ok(res, { answer, scope })
      } catch (err) {
        const message =
          err instanceof AiQueryError ? err.message : `AI 查询失败：${err?.message || '服务异常'}，请稍后重试`
        console.error(`[ai-query] 失败(非流式, ${Date.now() - t0}ms):`, message)
        return fail(res, message)
      }
    }

    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲，确保逐字即时下发
    })
    res.flushHeaders?.()

    let closed = false
    // 注意必须监听 res 而非 req：Node16+ 中 req 的 'close' 在请求体读完后即触发
    // （表示请求流结束，并非连接断开），会导致 closed 误置位、吞掉所有流式输出
    res.on('close', () => {
      closed = true
    })
    const send = (obj) => {
      if (closed || res.writableEnded || res.destroyed) return
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
      // 压缩/代理层可能缓冲，主动 flush 让增量即时到达
      if (typeof res.flush === 'function') res.flush()
    }
    // 心跳保活：SSE 注释行（不以 data: 开头，前端解析器自动忽略）
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) return
      res.write(': ping\n\n')
      if (typeof res.flush === 'function') res.flush()
    }, 1500)

    try {
      const { answer, scope } = await runAiQuery(req.user, question, {
        budgetMs: 75_000,
        onToken: (delta) => {
          tokenCount++
          send({ type: 'token', content: delta })
        },
      })
      send({ type: 'done', answer, scope })
      console.log(`[ai-query] 完成: ${tokenCount}个增量 / ${Date.now() - t0}ms / ${closed ? '但客户端已断开!' : '已送达'}`)
    } catch (err) {
      const message =
        err instanceof AiQueryError ? err.message : `AI 查询失败：${err?.message || '服务异常'}，请稍后重试`
      send({ type: 'error', message })
      console.error(`[ai-query] 失败(${Date.now() - t0}ms, ${tokenCount}个增量后):`, message)
    } finally {
      clearInterval(heartbeat)
      if (!res.writableEnded) res.end()
    }
  }),
)

export default router
