import { Router } from 'express'
import { config } from '../config.js'
import { getTable, listProjects, saveProject, deleteProject } from '../services/settings.js'
import { listAllRecords as fetchTableRecords, listMembers } from '../services/dingtalk-table.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

/**
 * 项目管理路由
 * - 普通用户：GET /api/projects 返回"我的项目"（成员身份以项目AI表格的「项目成员表」为准）
 * - 管理员：GET 返回全部项目，POST/DELETE 维护项目（Web管理端）
 */

/** 判断用户是否为某项目成员：读项目成员表，按通讯录unionId匹配；读不到成员表时不拦截（返回unknown） */
async function isProjectMember(user, p) {
  if (!getTable(p.id).enabled) return 'unknown' // 表格未启用无法判定
  const op = user.unionId || p.operatorUnionId || ''
  try {
    const members = await listMembers(op, p.id)
    if (!members.length) return 'unknown'
    return members.some((m) => m.unionId && m.unionId === user.unionId) ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

/**
 * GET /api/projects 我的项目列表
 * 管理员返回全部（可维护）；普通用户按成员表过滤（读不到成员表的项目兜底可见，避免误隐藏）
 */
router.get(
  '/projects',
  asyncRoute(async (req, res) => {
    const ps = listProjects()
    if (req.user.isAdmin) return ok(res, { isAdmin: true, projects: ps })

    const out = []
    for (const p of ps) {
      const member = await isProjectMember(req.user, p)
      if (member !== 'no') out.push(p)
    }
    ok(res, { isAdmin: false, projects: out })
  }),
)

/**
 * POST /api/projects 新建/更新项目（仅管理员）
 * body: { id?, name, baseId(支持粘贴钉钉文档链接自动提取), sheetId?, taskSheetName?, memberSheetName?, operatorUnionId? }
 */
router.post(
  '/projects',
  asyncRoute(async (req, res) => {
    if (!req.user.isAdmin) return fail(res, '仅管理员可维护项目', 403)
    const b = req.body || {}
    const p = {
      id: b.id ? String(b.id) : '',
      name: String(b.name || '').trim(),
      baseId: String(b.baseId || '').trim(),
      sheetId: String(b.sheetId || '').trim() || '工作日志表',
      taskSheetName: String(b.taskSheetName || '').trim() || '任务表',
      memberSheetName: String(b.memberSheetName || '').trim() || '项目成员表',
      operatorUnionId: String(b.operatorUnionId || '').trim(),
    }
    try {
      const saved = saveProject(p)
      ok(res, saved, p.id ? '项目已更新' : '项目已创建')
    } catch (err) {
      fail(res, err?.message || '保存失败')
    }
  }),
)

/** DELETE /api/projects/:id 删除项目（仅管理员；仅移除配置，AI表格数据不动） */
router.delete(
  '/projects/:id',
  asyncRoute(async (req, res) => {
    if (!req.user.isAdmin) return fail(res, '仅管理员可删除项目', 403)
    try {
      deleteProject(req.params.id)
      ok(res, { id: req.params.id }, '项目已删除（AI表格数据不受影响）')
    } catch (err) {
      fail(res, err?.message || '删除失败')
    }
  }),
)

/**
 * POST /api/projects/test 连接测试（仅管理员）
 * body: { id, baseId?, sheetId?, operatorUnionId? } — 未保存的修改先并入项目再测（同旧设置页体验）
 */
router.post(
  '/projects/test',
  asyncRoute(async (req, res) => {
    if (!req.user.isAdmin) return fail(res, '仅管理员可测试', 403)
    if (!config.dingtalkEnabled) {
      return ok(res, { ok: false, count: 0, message: '未配置钉钉应用凭据（.env），无法访问表格API' })
    }
    const b = req.body || {}
    if (!b.id) return fail(res, '请先保存项目再测试')

    try {
      const patch = { id: String(b.id) }
      if (b.baseId !== undefined) patch.baseId = String(b.baseId)
      if (b.sheetId !== undefined) patch.sheetId = String(b.sheetId)
      if (b.operatorUnionId !== undefined) patch.operatorUnionId = String(b.operatorUnionId)
      saveProject(patch)
    } catch (err) {
      return fail(res, err?.message || '项目不存在')
    }

    const t = getTable(String(b.id))
    if (!t.enabled) return ok(res, { ok: false, count: 0, message: 'AI表格链接未填写或未启用' })

    try {
      const rows = await fetchTableRecords({ force: true, operatorId: req.user.unionId || t.operatorUnionId, projectId: t.id })
      ok(res, { ok: true, count: rows.length, message: `连接成功，「${t.sheetId}」共读取 ${rows.length} 条记录` })
    } catch (err) {
      const msg = err?.response?.data?.message || err?.message || '未知错误'
      ok(res, { ok: false, count: 0, message: `连接失败：${msg}` })
    }
  }),
)

export default router
