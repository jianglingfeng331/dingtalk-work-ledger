import { Router } from 'express'
import { config } from '../config.js'
import { getTable, isLeader, listProjects, saveProject, deleteProject } from '../services/settings.js'
import { listAllRecords as fetchTableRecords, listMembers } from '../services/dingtalk-table.js'
import { createProjectTables } from '../services/table-factory.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

/**
 * 项目管理路由
 * - 普通用户：GET /api/projects 返回平台全部项目（附 member 成员标识，非成员仅展示不可切换）
 * - 新建/编辑：所有登录用户可用；普通用户新建进入待审核（pending），管理员审核通过才生效
 *   普通用户新建勾选自动建表时不立即建表（pendingAutoCreate 标记），审批通过时以管理员身份补建
 * - 删除/审核（approve/reject）：仅管理员
 * - 领导角色：项目配置 leaders[]（姓名+钉钉unionId），命中者移动端可见「下达指令」
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
 * GET /api/projects 项目列表
 * projects=已审核项目（管理员全量可维护；普通用户全量展示但附成员标识 member: yes/no/unknown）
 * pendingProjects=待审核项目：管理员看全部，普通用户只看自己提交的（审批通过前不进 projects，主流程选不到）
 * 每个项目附 isLeader：当前用户是否该项目领导角色（前端「下达指令」入口显隐依据）
 */
router.get(
  '/projects',
  asyncRoute(async (req, res) => {
    const ps = listProjects()
    const withFlag = (list) =>
      list.map((p) => ({ ...p, status: p.status || 'approved', isLeader: isLeader(req.user, p.id) }))
    const approved = ps.filter((p) => (p.status || 'approved') !== 'pending')
    const pending = ps.filter((p) => p.status === 'pending')

    if (req.user.isAdmin) {
      return ok(res, { isAdmin: true, projects: withFlag(approved), pendingProjects: withFlag(pending) })
    }
    const out = []
    for (const p of approved) {
      const member = await isProjectMember(req.user, p)
      out.push({ ...p, member, isLeader: isLeader(req.user, p.id) })
    }
    const minePending = pending.filter(
      (p) => p.createdBy?.unionId === req.user.unionId || p.createdBy?.userId === req.user.userId,
    )
    ok(res, { isAdmin: false, projects: out, pendingProjects: withFlag(minePending) })
  }),
)

/** 领导角色入参规整：[{name, unionId?, userId?}] 去重去空，最多10位 */
function sanitizeLeaders(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const l of raw.slice(0, 10)) {
    const name = String(l?.name || '').trim()
    if (!name) continue
    const key = l?.unionId || name
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, unionId: String(l?.unionId || '').trim(), userId: String(l?.userId || '').trim() })
  }
  return out
}

/**
 * POST /api/projects 新建/更新项目（所有登录用户）
 * body: { id?, name, baseId(支持粘贴钉钉文档链接自动提取), sheetId?, taskSheetName?, memberSheetName?, directiveSheetName?, operatorUnionId?, leaders?, autoCreateTable? }
 * 权限：管理员新建直接生效（可立即自动建表）；普通用户新建进入待审核（status=pending + createdBy），
 *   勾选自动建表则记 pendingAutoCreate 标记、审批通过时才建表；普通用户编辑直接生效
 * status/createdBy/pendingAutoCreate 均由服务端控制，不信任客户端字段
 * leaders 校验：姓名必须能在该项目「项目成员表」匹配到（钉钉用户系统验证），不匹配整体拒绝
 */
router.post(
  '/projects',
  asyncRoute(async (req, res) => {
    const b = req.body || {}
    const existing = b.id ? listProjects().find((x) => x.id === String(b.id)) : null
    if (b.id && !existing) return fail(res, '项目不存在', 404)
    const p = {
      id: b.id ? String(b.id) : '',
      name: String(b.name || '').trim(),
      baseId: String(b.baseId || '').trim(),
      sheetId: String(b.sheetId || '').trim() || '工作日志表',
      taskSheetName: String(b.taskSheetName || '').trim() || '任务表',
      memberSheetName: String(b.memberSheetName || '').trim() || '项目成员表',
      directiveSheetName: String(b.directiveSheetName || '').trim() || '领导指令表',
      operatorUnionId: String(b.operatorUnionId || '').trim(),
    }

    const leaders = sanitizeLeaders(b.leaders)
    if (leaders.length) {
      // 钉钉用户匹配验证：姓名必须在项目成员表（含通讯录用户）中命中
      // 仅已保存且表格启用的项目可验证；新建项目（尚未保存读不到成员表）先收姓名，编辑保存时再验证
      const verifiable = Boolean(p.id) && getTable(p.id).enabled
      if (verifiable) {
        try {
          const members = await listMembers(p.operatorUnionId, p.id)
          const unmatched = leaders.filter((l) => !members.some((m) => m.name === l.name))
          if (unmatched.length) {
            return fail(res, `领导「${unmatched.map((l) => l.name).join('、')}」不在项目成员表中，请核对姓名后重试`, 400)
          }
          // 命中的回填 unionId（供 isLeader 精确匹配）
          p.leaders = leaders.map((l) => {
            const m = members.find((x) => x.name === l.name)
            return { name: l.name, unionId: l.unionId || m?.unionId || '', userId: l.userId || '' }
          })
        } catch (err) {
          return fail(res, `无法读取项目成员表进行领导验证：${err?.message || '请检查表格配置'}`, 400)
        }
      } else {
        p.leaders = leaders
      }
    } else {
      p.leaders = []
    }

    // 项目别名（可选）：逗号分隔或数组，去重去空限10个，供 MCP skill 口语化项目名路由（如"城投ai项目"）
    // 未传 aliases 时不动已有配置（saveProject 按字段合并，空数组会把别名清掉）
    if (b.aliases !== undefined) {
      const aliasRaw = Array.isArray(b.aliases) ? b.aliases : String(b.aliases || '').split(/[,，、]/)
      p.aliases = [...new Set(aliasRaw.map((x) => String(x || '').trim().slice(0, 20)).filter(Boolean))].slice(0, 10)
    }

    // 自动建表与审核状态：管理员新建直接生效并立即建表；普通用户新建进入待审核、审批时才建表
    let autoCreatedUrl = ''
    let msg = ''
    if (req.user.isAdmin) {
      if (!p.id && b.autoCreateTable && !p.baseId) {
        try {
          const created = await createProjectTables({
            projectName: p.name,
            sheetNames: {
              log: p.sheetId,
              task: p.taskSheetName,
              member: p.memberSheetName,
              directive: p.directiveSheetName,
            },
            operatorUnionId: req.user.unionId,
          })
          p.baseId = created.baseId
          autoCreatedUrl = created.url
        } catch (err) {
          return fail(res, `自动建表失败：${err?.message || '请稍后重试'}`, 502)
        }
      }
      msg = p.id ? '项目已更新' : autoCreatedUrl ? '项目已创建，AI表格已自动建立' : '项目已创建'
    } else if (!existing) {
      // 普通用户新建：进入待审核；表格地址与自动建表二选一
      if (!p.baseId && !b.autoCreateTable) return fail(res, '请填写AI表格链接或开启自动建表', 400)
      p.status = 'pending'
      p.createdBy = { unionId: req.user.unionId || '', userId: req.user.userId || '', name: req.user.name || '' }
      if (b.autoCreateTable && !p.baseId) p.pendingAutoCreate = true
      msg = '已提交，等待管理员审核'
    } else {
      // 普通用户编辑：直接生效；补填表格地址后不再需要审批时自动建表
      if (p.baseId && existing.pendingAutoCreate) p.pendingAutoCreate = false
      msg = '项目已更新'
    }

    try {
      const saved = saveProject(p)
      ok(res, { ...saved, tableUrl: autoCreatedUrl || undefined }, msg)
    } catch (err) {
      fail(res, err?.message || '保存失败')
    }
  }),
)

/**
 * POST /api/projects/:id/approve 审核通过（仅管理员）
 * pending → approved；若提交时勾了自动建表且尚无 baseId，以管理员身份补建AI表格（失败保持待审核可重试）
 */
router.post(
  '/projects/:id/approve',
  asyncRoute(async (req, res) => {
    if (!req.user.isAdmin) return fail(res, '仅管理员可审核项目', 403)
    const p = listProjects().find((x) => x.id === req.params.id)
    if (!p) return fail(res, '项目不存在', 404)
    if (p.status !== 'pending') return fail(res, '该项目不在待审核状态', 400)

    const patch = { id: p.id, status: 'approved', pendingAutoCreate: false }
    let tableUrl = ''
    if (p.pendingAutoCreate && !p.baseId) {
      try {
        const created = await createProjectTables({
          projectName: p.name,
          sheetNames: {
            log: p.sheetId || '工作日志表',
            task: p.taskSheetName || '任务表',
            member: p.memberSheetName || '项目成员表',
            directive: p.directiveSheetName || '领导指令表',
          },
          operatorUnionId: req.user.unionId,
        })
        patch.baseId = created.baseId
        tableUrl = created.url
      } catch (err) {
        return fail(res, `自动建表失败，项目保持待审核：${err?.message || '请稍后重试'}`, 502)
      }
    }
    try {
      const saved = saveProject(patch)
      ok(res, { ...saved, tableUrl: tableUrl || undefined }, tableUrl ? '已通过审核，AI表格已自动建立' : '已通过审核')
    } catch (err) {
      fail(res, err?.message || '审核失败')
    }
  }),
)

/** POST /api/projects/:id/reject 拒绝审核（仅管理员）：移除该项目配置（自动建表的未建，无需清理文档） */
router.post(
  '/projects/:id/reject',
  asyncRoute(async (req, res) => {
    if (!req.user.isAdmin) return fail(res, '仅管理员可审核项目', 403)
    const p = listProjects().find((x) => x.id === req.params.id)
    if (!p) return fail(res, '项目不存在', 404)
    if (p.status !== 'pending') return fail(res, '该项目不在待审核状态', 400)
    try {
      deleteProject(req.params.id)
      ok(res, { id: req.params.id }, '已拒绝，项目已移除')
    } catch (err) {
      fail(res, err?.message || '操作失败')
    }
  }),
)

/**
 * GET /api/projects/:id/members 项目成员清单（仅管理员；设置页「领导角色设置」姓名匹配下拉用）
 */
router.get(
  '/projects/:id/members',
  asyncRoute(async (req, res) => {
    if (!req.user.isAdmin) return fail(res, '仅管理员可查看', 403)
    const t = getTable(req.params.id)
    if (!t.enabled) return ok(res, { members: [], message: '表格未启用，无法读取成员表' })
    try {
      const members = await listMembers(req.user.unionId || t.operatorUnionId, req.params.id)
      ok(res, { members })
    } catch (err) {
      fail(res, `成员表读取失败：${err?.message || '未知错误'}`)
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
