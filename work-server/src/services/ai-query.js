import { callTool } from './mcp.js'
import { getAI } from './settings.js'
import { listMembers } from './dingtalk-table.js'
import { AiTimeoutError, chat, chatStream, systemPrompt } from './llm.js'

/**
 * AI 智能查询服务（从 HTTP 路由抽取，供 /api/ai-query 与 MCP ai_query 工具共用）
 * 流程：识别查询范围 → MCP 工具拉取台账实时数据 → 数据+问题拼接 Prompt → LLM 推理
 */

export class AiQueryError extends Error {
  constructor(message, code = 'ai_error') {
    super(message)
    this.name = 'AiQueryError'
    this.code = code
  }
}

/** 判断日期(YYYY-MM-DD)是否在本自然周（周一 00:00 起） */
function withinThisWeek(dateStr) {
  if (!dateStr) return false
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return false
  const now = new Date()
  const day = (now.getDay() + 6) % 7 // 周一=0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day)
  return d >= monday
}

/**
 * @param {{userId:string,name:string,isAdmin:boolean,unionId?:string,projectId?:string}} user
 * @param {string} question 用户问题
 * @param {{budgetMs?:number, onToken?:(delta:string, full:string)=>void}} opts
 * @returns {Promise<{answer:string, scope:'personal'|'team'}>}
 */
export async function runAiQuery(user, question, { budgetMs = 75_000, onToken } = {}) {
  const ai = getAI()
  if (!ai.enabled) {
    throw new AiQueryError('AI 未启用：请管理员在「设置」页配置智谱 API Key 并打开 AI 开关', 'ai_disabled')
  }

  // 团队类问题需要管理员身份；管理员问到具体成员姓名时也自动升级为团队数据
  const wantsTeam = /团队|大家|全员|组内|所有人/.test(question)
  // MCP服务账号走Bearer令牌鉴权（持有者即管理员），无个人身份，默认全员范围
  // 否则按 userId='mcp-service' 做"个人"过滤会注入0条日志，导致skill查询查不到数据
  const isService = user.source === 'mcp' || user.userId === 'mcp-service'
  let team = isService || (wantsTeam && user.isAdmin)
  if (wantsTeam && !user.isAdmin && !isService) {
    return { answer: '团队维度的数据仅管理员可查询，你可以问我「我本周完成了哪些任务」等个人问题。', scope: 'personal' }
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
  const stats = await callTool('get_work_stats', { user, team })
  // 任务表/成员表实时拉取（失败不阻断，仅少一段上下文）
  let tasks = []
  let members = []
  let directives = []
  try {
    ;[tasks, members, directives] = await Promise.all([
      callTool('get_tasks', { user }),
      callTool('get_members', { user }),
      callTool('get_directives', { user }),
    ])
  } catch (err) {
    console.warn('[ai] 任务表/成员表/指令表拉取失败:', err?.message)
  }

  if (!records.length && !tasks.length) {
    return { answer: '当前还没有工作记录和任务，先去「工作记录」页随手记一条吧。', scope: team ? 'team' : 'personal' }
  }
  console.log(
    `[ai] 查询(${user.name}${team ? '/团队' : ''}): ${question.slice(0, 40)} | 注入: 日志${records.length}条 任务${tasks.length}项 指令${directives.length}项 成员${members.length}人`,
  )

  // 意图识别：问题属于任务/安排类且未提及日志类内容时，不注入工作日志段落与日志统计，
  // 避免模型把日志流水混入任务回答（用户要求：任务相关问答不要出现日志）
  // 周报/汇报/总结类需要任务+日志综合素材，不裁剪
  const taskOnly =
    /任务|安排|计划|进度|节点|分类|负责|分工|里程碑|待办/.test(question) &&
    !/日志|工时|做了什么|干了什么|工作内容|流水|记录了|周报|汇报|总结/.test(question)
  if (taskOnly) console.log('[ai] 命中任务类问题，跳过日志注入')

  // 周报/汇报/总结场景：过滤"已取消"任务（用户要求周报不提取消的工作；数据层过滤比提示词更可靠）
  const isWeekly = /周报|汇报|总结/.test(question)
  if (isWeekly && tasks.length) {
    const before = tasks.length
    tasks = tasks.filter((t) => !/取消/.test(String(t.status || '')))
    if (before !== tasks.length) console.log(`[ai] 周报场景过滤已取消任务: ${before}→${tasks.length}项`)
  }

  // LLM 推理：台账数据作为上下文注入
  // 任务表段落放在日志流水之前：避免长日志明细抢占注意力导致模型忽略任务表
  const dataContext = [
    `【台账数据｜维度: ${team ? '全员' : user.name}】`,
    taskOnly
      ? `（本次为任务类问题，仅提供任务表/成员/指令数据，不含工作日志）`
      : `统计: 共${stats.total}条，完成率${stats.doneRate}%，进度分布${JSON.stringify(stats.byProgress)}
${team ? `成员工作量: ${JSON.stringify(stats.byMember)}` : ''}
标签分布: ${JSON.stringify(stats.byTag)}`,
    tasks.length
      ? `【任务表（工作安排）｜共${tasks.length}项｜字段: 任务名/负责人/状态/计划节点/任务分类】\n${tasks
          .slice(0, 80)
          .map(
            (t) =>
              `- ${t.title}｜负责人:${t.owner || '未定'}｜状态:${t.status || '未定'}｜节点:${t.planDate || '未定'}｜分类:${t.category || '未定'}`,
          )
          .join('\n')}${tasks.length > 80 ? `\n（仅展示前80项，共${tasks.length}项）` : ''}`
      : '',
    members.length
      ? `【项目成员｜共${members.length}人】\n${members.map((m) => `- ${m.name}${m.roles?.length ? `（${m.roles.join('、')}）` : ''}`).join('\n')}`
      : '',
    directives.length
      ? `【领导指令（领导下达的任务安排）｜共${directives.length}项｜字段: 任务名/提出日期/负责人/办结时限/状态/执行进展】\n${directives
          .slice(0, 50)
          .map(
            (d) =>
              `- ${d.title}｜负责人:${d.owners?.join('、') || '未定'}｜办结时限:${d.deadline || '未定'}｜状态:${d.status}｜执行进展:${d.progress || '暂无'}`,
          )
          .join('\n')}${directives.length > 50 ? `\n（仅展示前50项，共${directives.length}项）` : ''}`
      : '【领导指令（领导下达的任务安排）｜当前0项：领导指令表暂无数据。注意：不要把任务表的数据当作领导指令作答】',
    ...(taskOnly
      ? []
      : [
          '【工作日志（已完成的工作流水）｜记录明细，工时为小时，空表示未记录】:',
          ...records
            .slice(0, 60)
            .map(
              (r) =>
                `- ${r.taskDate} [${r.progress}][工时${r.hours ?? '-'}] ${r.recorder}: ${r.title}｜原始内容: ${r.rawContent}｜标签: ${r.tags.join('、') || '无'}`,
            ),
        ]),
  ]
    .filter(Boolean)
    .join('\n')

  // 周报/汇报场景：算好总工时直接注入现成数字（模型自行汇总52条日志的工时易漏），
  // 并在用户消息前加紧贴上下文的文体指令（比 system 长规则对免费模型更有效）
  let userContent = `${question}\n\n${dataContext}`
  if (isWeekly) {
    const totalHours = records.reduce((s, r) => s + (Number(r.hours) || 0), 0)
    const weekHours = records
      .filter((r) => withinThisWeek(r.taskDate))
      .reduce((s, r) => s + (Number(r.hours) || 0), 0)
    const hoursLine =
      totalHours > 0
        ? `工时汇总: 项目累计总工时${totalHours}小时；本周（周一起）投入${weekHours}小时。`
        : '工时汇总: 工作日志中暂无工时记录。'
    userContent = `${question}

【输出要求】按周报文体写作：段落式叙述（可直接粘贴使用），首段总述整体进展、重点成果与工时投入；主体分段叙述各项工作（责任人、数字融入句子）；结尾谈风险与下周重点；不逐条罗列任务和日志、不用列表符号；不提及已取消的任务。

${dataContext}
${hoursLine}`
  }

  try {
    const llmMessages = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userContent },
    ]
    // 传 onToken 走流式（边生成边推送，首字延迟低）；MCP 工具等非流式调用仍用 chat
    const answer = onToken
      ? await chatStream(llmMessages, { onToken, budgetMs })
      : await chat(llmMessages, { budgetMs })
    if (!answer?.trim()) throw new AiQueryError('AI 返回内容为空，请重试', 'ai_empty')
    // 纯文本展示：兜底清除 LLM 偶发输出的 Markdown 星号/井号标记
    const clean = answer.trim().replace(/\*\*?/g, '').replace(/^#{1,6}\s*/gm, '')
    return { answer: clean, scope: team ? 'team' : 'personal' }
  } catch (err) {
    if (err instanceof AiQueryError) throw err
    if (err instanceof AiTimeoutError) {
      throw new AiQueryError('AI 查询超时（模型繁忙），请稍后重试', 'ai_timeout')
    }
    console.error('[ai] LLM 调用失败:', err?.response?.data || err?.message)
    throw new AiQueryError(`AI 查询失败：${err?.message || '服务异常'}，请稍后重试`, 'ai_error')
  }
}
