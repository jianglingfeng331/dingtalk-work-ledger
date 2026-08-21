import express, { Router } from 'express'
import { parseWorkContent } from '../services/parser.js'
import { addRecord, listRecords, mirrorCount } from '../services/store.js'
import { get as getSettings, getAI, getAsr } from '../services/settings.js'
import { chat, transcribe } from '../services/llm.js'
import * as xfyun from '../services/xfyun.js'
import { addPlanRecord, listMembers, listTaskCategories } from '../services/dingtalk-table.js'
import { enqueue, pendingStat } from '../services/pending-push.js'
import crypto from 'node:crypto'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

const PROGRESS_SET = new Set(['未开始', '进行中', '已完成'])

/**
 * 重复提交拦截：同一用户在配置窗口期内提交相同内容视为重复（窗口可在设置页调整）
 */
const lastSubmit = new Map() // userId -> { content, ts }

/**
 * POST /api/parse-work 预解析（不入库）
 * 语音/文字输入后先解析展示，用户在确认卡上修改补充后再提交
 */
router.post(
  '/parse-work',
  asyncRoute(async (req, res) => {
    const content = String(req.body?.content || '').trim()
    if (!content) return fail(res, '内容不能为空')
    ok(res, parseWorkContent(content, getSettings().tags))
  }),
)

/**
 * POST /api/asr 语音转写
 * 优先讯飞语音听写（传统引擎，免费额度）；未配置时降级智谱 GLM-ASR（付费）
 * body: 原始音频二进制（前端统一转 16k 单声道 WAV），Content-Type: audio/wav
 */
router.post(
  '/asr',
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '10mb' }),
  asyncRoute(async (req, res) => {
    if (!req.body?.length) return fail(res, '未收到音频数据')
    const errors = []
    let xfyunErr = ''
    // 1) 讯飞（配置齐备时）
    if (getAsr().enabled) {
      try {
        const text = await xfyun.transcribe(req.body)
        return ok(res, { text, engine: 'xfyun' })
      } catch (err) {
        xfyunErr = err?.message || '识别失败'
      }
    }
    // 2) 智谱 GLM-ASR 兜底（需账户余额）
    try {
      const text = await transcribe(req.body)
      return ok(res, { text, engine: 'zhipu' })
    } catch (err) {
      errors.push(err?.message || '识别失败')
    }
    // 讯飞已启用时以讯飞错误为主（避免兜底的“余额不足”误导排查方向）
    if (xfyunErr) return fail(res, `讯飞识别失败：${xfyunErr}（智谱兜底：${errors[0] || '不可用'}）`)
    fail(res, errors.join('；') || '语音识别失败')
  }),
)

/**
 * POST /api/enrich-work 智能润色（语音转写文字 → 通顺工作描述）
 * 优先 LLM；未配置/失败时规则扩写降级（保证可用）
 */
router.post(
  '/enrich-work',
  asyncRoute(async (req, res) => {
    const content = String(req.body?.content || '').trim()
    if (!content) return fail(res, '内容不能为空')

    const ai = getAI()
    if (ai.enabled) {
      try {
        const text = await chat([
          { role: 'system', content: '你是工作台账助手。把用户的口语化工作描述润色为通顺、简洁的书面工作记录。只输出润色后的内容本身，不要解释、不要加标题，保留原有的事实信息（事项、人员、时间、工时、进度），100字以内。' },
          { role: 'user', content },
        ])
        if (text?.trim()) return ok(res, { content: text.trim(), source: 'ai' })
      } catch (err) {
        console.warn('[enrich-work] AI润色失败，降级规则整理:', err?.message)
      }
    }

    // 规则润色：去口头语、补标点
    const polished = content
      .replace(/(嗯+|呃+|那个|就是说|然后呢|对吧|啊+)[，,]?/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[，,]\s*[，,]/g, '，')
      .trim()
    ok(res, { content: polished || content, source: 'rule' })
  }),
)

/**
 * POST /api/submit-work 提交工作记录
 * body.content          原始内容（语音识别文本或文字输入）
 * body.overrides        用户在确认卡修改后的字段：{ progress, hours }，覆盖规则解析结果
 * 标题/日期/标签始终基于最终 content 重新解析，保证一致
 */
router.post(
  '/submit-work',
  asyncRoute(async (req, res) => {
    const content = String(req.body?.content || '').trim()
    if (!content) return fail(res, '工作内容不能为空')
    if (content.length > 500) return fail(res, '内容过长，请控制在500字以内')

    const dedupMs = (getSettings().dedupWindowSec || 60) * 1000
    const last = lastSubmit.get(req.user.userId)
    if (dedupMs > 0 && last && last.content === content && Date.now() - last.ts < dedupMs) {
      return fail(res, '相同内容刚已提交过，请勿重复提交')
    }

    // 规则解析
    const parsed = parseWorkContent(content, getSettings().tags)

    // 用户确认卡字段覆盖（完成情况 / 工时）
    const ov = req.body?.overrides || {}
    if (ov.progress && PROGRESS_SET.has(ov.progress)) parsed.progress = ov.progress
    if (ov.hours !== undefined && ov.hours !== null && ov.hours !== '') {
      const h = Number(ov.hours)
      if (Number.isFinite(h) && h >= 0 && h <= 24) parsed.hours = h
    }

    const record = await addRecord({ user: req.user, rawContent: content, parsed, projectId: req.user.projectId })

    lastSubmit.set(req.user.userId, { content, ts: Date.now() })
    ok(
      res,
      { id: record.id, pendingSync: record.pendingSync },
      record.pendingSync ? '已保存，网络恢复后自动同步表格' : '记录成功',
    )
  }),
)

/**
 * GET /api/get-work-list 获取工作记录（权限隔离：仅本人；管理员 team=1 可查全员）
 * query: scope = all | today | week | undone；team = 1（管理员）
 */
router.get(
  '/get-work-list',
  asyncRoute(async (req, res) => {
    const team = req.query.team === '1' || req.query.team === 'true'
    if (team && !req.user.isAdmin) return fail(res, '仅管理员可查看全员工作记录', 403)

    const list = await listRecords({
      user: req.user,
      scope: req.query.scope || 'all',
      team,
      projectId: req.user.projectId,
    })
    // 诊断日志：定位“列表条数不对”类问题（谁查的、什么条件、返回几条）
    console.log(
      `[list] ${new Date().toLocaleTimeString()} user=${req.user.userId}(${req.user.name}) union=${req.user.unionId || '无'} project=${req.user.projectId || '默认'} scope=${req.query.scope || 'all'} team=${team ? 1 : 0} → ${list.length}条/镜像${mirrorCount()}`,
    )
    ok(res, list)
  }),
)

/* ===================== 计划模块（写入任务表） ===================== */

/**
 * GET /api/plan-options 计划确认卡选项：项目成员 + 任务分类
 * 成员含unionId（写任务表负责人user列用）
 */
router.get(
  '/plan-options',
  asyncRoute(async (req, res) => {
    const op = req.user.unionId || ''
    const [members, categories] = await Promise.all([
      listMembers(op).catch(() => []),
      listTaskCategories(op).catch(() => ['项目管理', '客户沟通', '技术研发', '前端部署', '其它']),
    ])
    ok(res, { members, categories })
  }),
)

/**
 * POST /api/parse-plan 计划预解析（不入库）：LLM提取 任务标题/负责人/计划节点/任务分类
 * 解析失败降级：标题=原文，其余留空由用户补充
 */
router.post(
  '/parse-plan',
  asyncRoute(async (req, res) => {
    const content = String(req.body?.content || '').trim()
    if (!content) return fail(res, '内容不能为空')

    const op = req.user.unionId || ''
    const pid = req.user.projectId
    const [members, categories] = await Promise.all([
      listMembers(op, pid).catch(() => []),
      listTaskCategories(op, pid).catch(() => []),
    ])
    const today = new Date()
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    const ai = getAI()
    if (ai.enabled) {
      try {
        const reply = await chat(
          [
            { role: 'system', content: '你是工作计划解析助手。只输出一个JSON对象，不要解释、不要markdown代码块。' },
            {
              role: 'user',
              content: [
                `今天是${fmt(today)}（${['日', '一', '二', '三', '四', '五', '六'][today.getDay()]}）。`,
                '从下面这段计划描述中提取字段，输出JSON：{"title":"任务标题(20字内概括)","owner":"负责人姓名","planDate":"计划节点日期YYYY-MM-DD","category":"任务分类"}',
                `负责人必须从名单里选：${members.map((m) => m.name).join('、')}（找不到填""）`,
                `任务分类必须从选项里选：${categories.join('、')}（判断不了填"其它"）`,
                '相对日期必须精确换算（今天周五，则下周一=+3天、下周三=+5天、下周五=+7天；本月月底按当月最后一天）。计划描述：' + content,
              ].join('\n'),
            },
          ],
          { budgetMs: 20_000 },
        )
        const m = String(reply || '').match(/\{[\s\S]*\}/)
        if (m) {
          const j = JSON.parse(m[0])
          ok(res, {
            title: String(j.title || '').slice(0, 30) || content.slice(0, 20),
            ownerName: members.find((x) => x.name === j.owner)?.name || '',
            planDate: /^\d{4}-\d{2}-\d{2}$/.test(String(j.planDate || '')) ? j.planDate : '',
            category: categories.includes(j.category) ? j.category : '',
            source: 'ai',
          })
          return
        }
      } catch (err) {
        console.warn('[parse-plan] AI解析失败，降级原文:', err?.message)
      }
    }
    ok(res, { title: content.slice(0, 20), ownerName: '', planDate: '', category: '', source: 'rule' })
  }),
)

/**
 * POST /api/submit-plan 提交计划 → 任务表
 * body: { title, ownerName, planDate, category }（确认卡最终值）
 * 推送失败不丢：入补推队列，返回半成功（pendingSync=true），由队列自动重推
 */
router.post(
  '/submit-plan',
  asyncRoute(async (req, res) => {
    const { title, ownerName, planDate, category } = req.body || {}
    if (!title || !String(title).trim()) return fail(res, '任务标题不能为空')
    if (!ownerName) return fail(res, '请选择负责人')

    const op = req.user.unionId || ''
    const pid = req.user.projectId
    const members = await listMembers(op, pid).catch(() => [])
    const owner = members.find((m) => m.name === ownerName)
    if (!owner) return fail(res, `负责人「${ownerName}」不在项目成员表中`)

    const plan = {
      title: String(title).trim().slice(0, 50),
      ownerUnionId: owner.unionId || '',
      ownerName: owner.name,
      planDate: /^\d{4}-\d{2}-\d{2}$/.test(String(planDate || '')) ? planDate : '',
      category: String(category || '').trim(),
      projectId: pid,
    }
    const clientToken = crypto.randomUUID()

    let pendingSync = false
    try {
      await addPlanRecord(plan, op, clientToken, pid)
      console.log(`[plan] ${req.user.name} 提交计划: ${plan.title} → 负责人${ownerName} 节点${plan.planDate || '未定'} 分类${plan.category || '未定'}`)
    } catch (err) {
      pendingSync = true
      enqueue({ type: 'plan', clientToken, payload: plan })
      console.warn(`[plan] 任务表推送失败，已入补推队列(${clientToken.slice(0, 8)}):`, err?.response?.data?.message || err?.message)
    }
    ok(res, { pendingSync }, pendingSync ? '计划已保存，网络恢复后自动同步任务表' : '计划已加入任务表')
  }),
)

/** GET /api/pending-push 补推队列状态（诊断/设置页展示） */
router.get('/pending-push', (req, res) => ok(res, pendingStat()))

export default router
