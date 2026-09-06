/**
 * 一次性端到端验证：领导下达指令全链路（真实钉钉AI表格）
 * 验证点：
 *   1. createDirective：指令表新增行 + 任务表自动建关联任务 + links 映射落盘
 *   2. syncDirectiveStatus：任务状态 → 指令状态同步（含逾期判定）
 *   3. syncDirectiveProgress：无当日日志时跳过（保留历史综述）
 *   4. listDirectives 回读：行数据与字段映射正确
 *   5. 清理：删除测试指令行与任务行，还原现场
 * 用法：node scripts/e2e-directive-check.mjs
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../src/services/settings.js'
import * as table from '../src/services/dingtalk-table.js'
import { createDirective, allLinks, syncDirectiveStatus, syncDirectiveProgress } from '../src/services/directive.js'

const PID = 'p_chengtou'
const OP = '9oWpUHcnbfoiE' // 项目操作人（蒋凌峰）
const TITLE = '【测试】领导指令全链路验证'
const pad2 = (n) => String(n).padStart(2, '0')
const plusDays = (n) => {
  const d = new Date(Date.now() + n * 86400_000)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

/* ---------- 1. 下达指令 ---------- */
const members = await table.listMembers(OP, PID)
console.log(`成员表 ${members.length} 人: ${members.slice(0, 5).map((m) => m.name).join('、')}${members.length > 5 ? '…' : ''}`)
const owner = members.find((m) => m.unionId === OP) || members[0]
const deadline = plusDays(7)

let created
try {
  created = await createDirective({
    user: { unionId: OP, name: owner?.name || '测试领导' },
    projectId: PID,
    title: TITLE,
    ownerNames: [owner.name, members.find((m) => m.unionId !== OP)?.name].filter(Boolean),
    deadline,
    status: '未开始',
    progress: '',
  })
  check('指令创建（写指令表+任务表+落映射）', Boolean(created.directiveRecordId && created.taskRecordId && !created.taskPendingSync),
    `指令=${created.directiveRecordId} 任务=${created.taskRecordId} 待同步=${created.taskPendingSync}`)
} catch (err) {
  check('指令创建', false, err.message)
  console.log(results)
  process.exit(1)
}

/* ---------- 2. 回读验证两表数据 ---------- */
await new Promise((r) => setTimeout(r, 1500))
const [directives, tasks] = await Promise.all([
  table.listDirectives(OP, PID, { force: true }),
  table.listTasks(OP, PID, { force: true }),
])
const dirRow = directives.find((d) => d.recordId === created.directiveRecordId)
const taskRow = tasks.find((t) => t.recordId === created.taskRecordId)
check('指令表回读：字段映射正确', Boolean(dirRow)
  && dirRow.title === TITLE
  && dirRow.deadline === deadline
  && dirRow.status === '未开始'
  && dirRow.raisedAt,
  `状态=${dirRow?.status} 时限=${dirRow?.deadline} 提出日期=${dirRow?.raisedAt} 负责人=${(dirRow?.owners || []).join('、')}`)
check('任务表回读：关联任务已创建', Boolean(taskRow)
  && taskRow.title === TITLE
  && taskRow.planDate === deadline
  && (taskRow.ownerUnionIds || []).includes(owner.unionId),
  `负责人=${taskRow?.owner} 参与人=${(taskRow.memberUnionIds || []).length}人 状态=${taskRow?.status}`)
check('links 强关联映射', allLinks()[created.taskRecordId]?.directiveRecordId === created.directiveRecordId)

/* ---------- 3. 状态联动：任务状态变更 → 指令状态 ---------- */
const st = await syncDirectiveStatus(PID, created.taskRecordId, '进行中', deadline)
await new Promise((r) => setTimeout(r, 1500))
const after1 = (await table.listDirectives(OP, PID, { force: true })).find((d) => d.recordId === created.directiveRecordId)
check('状态联动：任务「进行中」→ 指令同步', st.synced && after1.status === '进行中', `指令状态=${after1.status}`)

// 逾期判定：任务未完成 + 时限已过 → 已延期
const st2 = await syncDirectiveStatus(PID, created.taskRecordId, '进行中', '2020-01-01')
await new Promise((r) => setTimeout(r, 1500))
const after2 = (await table.listDirectives(OP, PID, { force: true })).find((d) => d.recordId === created.directiveRecordId)
check('状态联动：逾期任务 → 指令「已延期」', st2.synced && after2.status === '已延期', `指令状态=${after2.status}`)

// 完成态不判逾期
const st3 = await syncDirectiveStatus(PID, created.taskRecordId, '已完成', '2020-01-01')
await new Promise((r) => setTimeout(r, 1500))
const after3 = (await table.listDirectives(OP, PID, { force: true })).find((d) => d.recordId === created.directiveRecordId)
check('状态联动：已完成不判逾期', st3.synced && after3.status === '已完成', `指令状态=${after3.status}`)

/* ---------- 4. 进展联动：无当日日志应跳过 ---------- */
const pr = await syncDirectiveProgress(PID, created.taskRecordId, { chat: async () => '' })
check('进展联动：无当日日志不动（保留历史综述）', pr.skipped === true, `reason=${pr.reason}`)

/* ---------- 5. 清理测试数据 ---------- */
const LINK_FILE = path.join(DATA_DIR, 'directive-links.json')
async function deleteRecords(sheetName, ids) {
  if (!ids.length) return
  const { getAccessToken } = await import('../src/services/dingtalk.js')
  const axios = (await import('axios')).default
  const BASE = 'kDnRL6jAJM34j50ZI9rRwr2aWyMoPYe1'
  const t = await getAccessToken()
  const { data } = await axios.post(
    `https://api.dingtalk.com/v1.0/notable/bases/${BASE}/sheets/${encodeURIComponent(sheetName)}/records/delete?operatorId=${OP}`,
    { recordIds: ids },
    { headers: { 'x-acs-dingtalk-access-token': t, 'Content-Type': 'application/json' } },
  )
  return data
}
try {
  await deleteRecords('领导指令表', [created.directiveRecordId])
  await deleteRecords('任务表', [created.taskRecordId])
  const links = JSON.parse(fs.readFileSync(LINK_FILE, 'utf8'))
  delete links[created.taskRecordId]
  fs.writeFileSync(LINK_FILE, JSON.stringify(links, null, 2))
  const remain = (await table.listDirectives(OP, PID, { force: true })).filter((d) => d.title === TITLE)
  check('清理：测试数据已删除还原', remain.length === 0, '指令行/任务行/映射均已清')
} catch (err) {
  check('清理测试数据', false, err.message)
}

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.pass)
console.log(`\n===== 端到端验证 ${failed.length ? '未通过 ' + failed.length + ' 项' : '全部通过'}（${results.length - failed.length}/${results.length}）=====`)
process.exit(failed.length ? 1 : 0)
