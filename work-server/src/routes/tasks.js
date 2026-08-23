import { Router } from 'express'
import { getTable } from '../services/settings.js'
import * as table from '../services/dingtalk-table.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

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
      mine ? null : table.listAllRecords({ operatorId: op, projectId: pid }),
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
      .map((t) => ({ ...t, ...(stat.get(t.recordId) || { logCount: 0, totalHours: 0, lastDate: '' }) }))
      .sort((a, b) => b.logCount - a.logCount || String(b.lastDate).localeCompare(String(a.lastDate)))

    ok(res, { enabled: true, tasks: list })
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
