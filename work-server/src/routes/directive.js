import { Router } from 'express'
import { getTable, isLeader, getAI } from '../services/settings.js'
import * as table from '../services/dingtalk-table.js'
import { createDirective, allLinks, normalizeParsedDirective } from '../services/directive.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'
import { checkText } from '../utils/text-guard.js'

const router = Router()

/**
 * 领导指令路由
 * - POST /api/parse-directive 指令AI预解析（不入库，仅领导/管理员）
 * - POST /api/submit-directive 下达指令（仅项目领导/管理员）
 * - GET  /api/directives      指令清单+任务关联状态（仅领导/管理员，AI查询与领导看板用）
 */

const stripTags = (s) => String(s || '').replace(/<\/?[a-zA-Z][^>]*>/g, '').trim()

/** 领导权限：项目 leaders 配置命中，或全局管理员 */
function canDirective(user) {
  return isLeader(user, user.projectId) || user.isAdmin
}

/**
 * POST /api/parse-directive 指令AI预解析（不入库）
 * body: { content } → { title, owners[], deadline, status, source }
 * 把领导的口语化指令拆解到表单字段，人工可编辑后再提交
 * 解析失败降级：标题=原文，其余留空由用户补充
 */
router.post(
  '/parse-directive',
  asyncRoute(async (req, res) => {
    if (!canDirective(req.user)) return fail(res, '仅领导角色可使用指令解析', 403)
    const content = stripTags(req.body?.content)
    if (!content) return fail(res, '内容不能为空')
    const bad = checkText(content, '指令描述', req.user)
    if (bad) return fail(res, bad, 400)

    const pid = req.user.projectId
    const members = await table.listMembers(req.user.unionId || '', pid).catch(() => [])
    const memberNames = members.map((m) => m.name).filter(Boolean)

    const today = new Date()
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    if (getAI().enabled) {
      try {
        const { chat } = await import('../services/llm.js')
        const reply = await chat(
          [
            { role: 'system', content: '你是领导指令解析助手。只输出一个JSON对象，不要解释、不要markdown代码块。' },
            {
              role: 'user',
              content: [
                `今天是${fmt(today)}（${['日', '一', '二', '三', '四', '五', '六'][today.getDay()]}）。`,
                '从下面这段领导指令中提取字段，输出JSON：{"title":"任务名称(30字内概括)","owners":["负责人姓名"],"deadline":"办结时限YYYY-MM-DD","status":"状态"}',
                `负责人必须从名单里选，可多个：${memberNames.join('、') || '（名单为空，填[]）'}（找不到填[]）`,
                '状态必须从选项里选：未开始、进行中、已完成、已延期（默认"未开始"，仅当指令明确说已完成/已在推进时才改）',
                '相对日期必须精确换算（今天周五，则下周一=+3天、下周三=+5天；月底按当月最后一天；未提到时限填""）。指令描述：' + content,
              ].join('\n'),
            },
          ],
          { budgetMs: 20_000 },
        )
        const m = String(reply || '').match(/\{[\s\S]*\}/)
        if (m) {
          const parsed = normalizeParsedDirective(JSON.parse(m[0]), memberNames, content)
          return ok(res, { ...parsed, source: 'ai' })
        }
      } catch (err) {
        console.warn('[parse-directive] AI解析失败，降级原文:', err?.message)
      }
    }
    ok(res, { ...normalizeParsedDirective({}, memberNames, content), source: 'rule' })
  }),
)

/**
 * POST /api/submit-directive 下达指令
 * body: { title, ownerNames[], deadline('YYYY-MM-DD'), status?, progress? }
 * 一次写入领导指令表 + 任务表自动建关联任务
 */
router.post(
  '/submit-directive',
  asyncRoute(async (req, res) => {
    if (!getTable(req.user.projectId).enabled) return fail(res, '未连接钉钉AI表格，指令功能不可用', 400)
    if (!canDirective(req.user)) return fail(res, '仅领导角色可下达指令', 403)

    const b = req.body || {}
    const title = stripTags(b.title)
    const bad = checkText(title, '指令任务名称', req.user) || checkText(b.progress, '执行进展', req.user)
    if (bad) return fail(res, bad, 400)
    const ownerNames = Array.isArray(b.ownerNames)
      ? [...new Set(b.ownerNames.map((n) => String(n || '').trim()).filter(Boolean))]
      : []

    try {
      const out = await createDirective({
        user: req.user,
        projectId: req.user.projectId,
        title,
        ownerNames,
        deadline: String(b.deadline || '').trim(),
        status: String(b.status || '未开始').trim(),
        progress: stripTags(b.progress),
      })
      ok(
        res,
        out,
        out.taskPendingSync ? '指令已记录，关联任务创建失败将自动重试同步' : '指令已下达，任务表已自动创建关联任务',
      )
    } catch (err) {
      fail(res, err?.message || '指令下达失败')
    }
  }),
)

/**
 * GET /api/directives 指令清单（领导/管理员）
 * 附带关联任务的实时状态与最新日志时间，供领导查看指令执行情况
 * ?refresh=1 强刷缓存
 */
router.get(
  '/directives',
  asyncRoute(async (req, res) => {
    if (!canDirective(req.user)) return fail(res, '仅领导角色可查看指令清单', 403)
    const pid = req.user.projectId
    if (!getTable(pid).enabled) return ok(res, { enabled: false, directives: [] })

    const force = req.query.refresh === '1' || req.query.refresh === 'true'
    const [directives, tasks] = await Promise.all([
      table.listDirectives(req.user.unionId || '', pid, { force }).catch(() => []),
      table.listTasks(req.user.unionId || '', pid, { force }).catch(() => []),
    ])
    const linkByDirective = new Map(
      Object.entries(allLinks()).map(([taskId, l]) => [l.directiveRecordId, taskId]),
    )

    const list = directives.map((d) => {
      const taskId = linkByDirective.get(d.recordId) || ''
      const task = taskId ? tasks.find((t) => t.recordId === taskId) : null
      return {
        ...d,
        taskRecordId: taskId,
        taskStatus: task?.status || '',
        taskOwner: task?.owner || '',
        linked: Boolean(task),
      }
    })
    ok(res, { enabled: true, directives: list })
  }),
)

export default router
