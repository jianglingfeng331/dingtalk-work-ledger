import { Router } from 'express'
import { getTable } from '../services/settings.js'
import * as table from '../services/dingtalk-table.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

/** 任务状态合法值（与AI表格状态列选项一致） */
const TASK_STATUSES = ['未开始', '进行中', '已完成']

/** 当前用户是否该任务负责人（unionId精确匹配优先，负责人列只回姓名时按姓名兜底） */
function isOwnerOf(task, user) {
  const uid = user?.unionId || ''
  if (uid && (task.ownerUnionIds || []).includes(uid)) return true
  const name = String(user?.name || '').trim()
  return Boolean(name) && String(task.owner || '').split('、').filter(Boolean).includes(name)
}

/**
 * GET /api/tasks 任务视图：任务清单 + 关联日志聚合（日志数/累计工时/最近更新）
 * 数据全部来自当前项目的钉钉AI表格（任务表 + 工作日志表原生关联），未接表格时返回 enabled:false
 * ?mine=1 只返回与当前用户相关的任务（负责人或参与人含该用户；无参与人列时仅按负责人）
 */
router.get(
  '/tasks',
  asyncRoute(async (req, res) => {
    const pid = req.user.projectId
    const op = req.user.unionId || ''
    if (!getTable(pid).enabled) return ok(res, { enabled: false, tasks: [] })

    const mine = req.query.mine === '1' || req.query.mine === 'true'
    const [tasks, logs] = await Promise.all([
      table.listTasks(op, pid),
      // 两种模式都要日志聚合：任务卡"工时/日志数"徽标在"我的"模式下同样需要（30s缓存，代价小）
      table.listAllRecords({ operatorId: op, projectId: pid }),
    ])

    // 我的相关任务：unionId 精确匹配优先；负责人/参与人列若只回姓名，则按姓名兜底
    let base = tasks
    if (mine) {
      const uid = req.user.unionId || ''
      const name = (req.user.name || '').trim()
      base = tasks.filter((t) => {
        if (uid && (t.ownerUnionIds?.includes(uid) || t.memberUnionIds?.includes(uid))) return true
        if (name) {
          const owners = String(t.owner || '').split('、').filter(Boolean)
          const members = String(t.members || '').split('、').filter(Boolean)
          if (owners.includes(name) || members.includes(name)) return true
        }
        return false
      })
    }

    // 按任务聚合日志统计
    const stat = new Map()
    for (const log of logs || []) {
      for (const tid of log.linkTaskRecordIds || []) {
        const cur = stat.get(tid) || { logCount: 0, totalHours: 0, lastDate: '' }
        cur.logCount += 1
        cur.totalHours = Math.round(((cur.totalHours || 0) + (Number(log.hours) || 0)) * 10) / 10
        if (String(log.taskDate) > cur.lastDate) cur.lastDate = log.taskDate
        stat.set(tid, cur)
      }
    }

    const list = base
      .map((t) => ({
        ...t,
        editable: isOwnerOf(t, req.user), // 仅负责人可改状态，前端据此显示可编辑视觉
        ...(stat.get(t.recordId) || { logCount: 0, totalHours: 0, lastDate: '' }),
      }))
      .sort((a, b) => b.logCount - a.logCount || String(b.lastDate).localeCompare(String(a.lastDate)))

    ok(res, { enabled: true, tasks: list })
  }),
)

/**
 * POST /api/tasks/:id/status 修改任务状态（仅负责人）
 * body: { status } —— 值必须为 未开始/进行中/已完成
 */
router.post(
  '/tasks/:id/status',
  asyncRoute(async (req, res) => {
    const pid = req.user.projectId
    if (!getTable(pid).enabled) return fail(res, '未连接钉钉AI表格，任务视图不可用', 400)

    const status = String(req.body?.status || '').trim()
    if (!TASK_STATUSES.includes(status)) {
      return fail(res, `无效状态：${status || '（空）'}，可选 ${TASK_STATUSES.join(' / ')}`, 400)
    }

    // 服务端权限校验：仅负责人可改（前端 editable 只是视觉，安全边界在这里）
    const tasks = await table.listTasks(req.user.unionId || '', pid)
    const task = tasks.find((t) => t.recordId === req.params.id)
    if (!task) return fail(res, '任务不存在或已被删除', 404)
    if (!isOwnerOf(task, req.user)) return fail(res, '仅任务负责人可修改状态', 403)

    await table.updateTaskStatus(req.params.id, status, req.user.unionId || '', pid)
    ok(res, { recordId: req.params.id, status })
  }),
)

/**
 * GET /api/tasks/:id/logs 单任务关联日志（时间倒序，最多50条）
 */
router.get(
  '/tasks/:id/logs',
  asyncRoute(async (req, res) => {
    const pid = req.user.projectId
    if (!getTable(pid).enabled) return fail(res, '未连接钉钉AI表格，任务视图不可用', 400)

    const logs = await table.listAllRecords({ operatorId: req.user.unionId || '', projectId: pid })
    const list = logs
      .filter((l) => (l.linkTaskRecordIds || []).includes(req.params.id))
      .sort((a, b) => String(b.taskDate).localeCompare(String(a.taskDate)))
      .slice(0, 50)
      .map(({ id, recorder, taskDate, hours, progress, rawContent }) => ({
        id,
        recorder,
        taskDate,
        hours,
        progress,
        rawContent,
      }))

    ok(res, list)
  }),
)

export default router
