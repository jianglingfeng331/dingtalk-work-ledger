import { Router } from 'express'
import { callTool } from '../services/mcp.js'
import { getAI } from '../services/settings.js'
import { listMembers } from '../services/dingtalk-table.js'
import { AiTimeoutError, chat, systemPrompt } from '../services/llm.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

/**
 * POST /api/ai-query AI 智能查询（正式版）
 * 流程：识别查询范围 → MCP 工具拉取台账实时数据 → 数据+问题拼接 Prompt → LLM 推理
 * 未配置 AI / 推理失败 / 超时：明确报错，不做演示或规则降级
 */
router.post(
  '/ai-query',
  asyncRoute(async (req, res) => {
    const question = String(req.body?.question || '').trim()
    if (!question) return fail(res, '问题不能为空')
    const user = req.user

    const ai = getAI()
    if (!ai.enabled) {
      return fail(res, 'AI 未启用：请管理员在「设置」页配置智谱 API Key 并打开 AI 开关')
    }

    // 团队类问题需要管理员身份；管理员问到具体成员姓名时也自动升级为团队数据
    const wantsTeam = /团队|大家|全员|组内|所有人/.test(question)
    let team = wantsTeam && user.isAdmin
    if (wantsTeam && !user.isAdmin) {
      return ok(res, '团队维度的数据仅管理员可查询，你可以问我「我本周完成了哪些任务」等个人问题。')
    }
    if (!team && user.isAdmin) {
      try {
        const members = await listMembers(user.unionId, user.projectId)
        const hit = members.some((m) => m.name && m.name !== user.name && question.includes(m.name))
        if (hit) team = true
      } catch {
        /* 成员表读取失败不影响默认个人范围 */
      }
    }

    // MCP 工具获取实时数据上下文
    const records = await callTool('get_work_records', { user, scope: 'all', team })
    if (!records.length) {
      return ok(res, '当前还没有工作记录，先去「工作记录」页随手记一条吧。')
    }
    const stats = await callTool('get_work_stats', { user, team })

    // LLM 推理：台账数据作为上下文注入（45s 预算，含限流退避与备用模型切换）
    const dataContext = [
      `【台账数据｜维度: ${team ? '全员' : user.name}】`,
      `统计: 共${stats.total}条，完成率${stats.doneRate}%，进度分布${JSON.stringify(stats.byProgress)}`,
      team ? `成员工作量: ${JSON.stringify(stats.byMember)}` : '',
      `标签分布: ${JSON.stringify(stats.byTag)}`,
      '记录明细（工时为小时，空表示未记录）:',
      ...records
        .slice(0, 60)
        .map(
          (r) =>
            `- ${r.taskDate} [${r.progress}][工时${r.hours ?? '-'}] ${r.recorder}: ${r.title}｜原始内容: ${r.rawContent}｜标签: ${r.tags.join('、') || '无'}`,
        ),
    ]
      .filter(Boolean)
      .join('\n')

    try {
      const answer = await chat(
        [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: `${question}\n\n${dataContext}` },
        ],
        { budgetMs: 45_000 },
      )
      if (!answer?.trim()) return fail(res, 'AI 返回内容为空，请重试')
      return ok(res, answer.trim())
    } catch (err) {
      if (err instanceof AiTimeoutError) {
        return fail(res, 'AI 查询超时（模型繁忙），请稍后重试')
      }
      console.error('[ai] LLM 调用失败:', err?.response?.data || err?.message)
      return fail(res, `AI 查询失败：${err?.message || '服务异常'}，请稍后重试`)
    }
  }),
)

export default router
