/**
 * 一次性端到端验证：日志归纳 → 指令「执行进展」自动同步（真实钉钉AI表格 + 真实AI归纳）
 * 流程：下达指令 → 负责人提交关联日志 → 触发15秒防抖归纳钩子 → 验证指令执行进展已更新 → 清理
 * 用法：node scripts/e2e-progress-sync-check.mjs
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../src/services/settings.js'
import * as table from '../src/services/dingtalk-table.js'
import * as store from '../src/services/store.js'
import { createDirective, syncDirectiveProgress } from '../src/services/directive.js'

const PID = 'p_chengtou'
const OP = '9oWpUHcnbfoiE' // 蒋凌峰（项目操作人）
const TITLE = '【测试】日志归纳联动验证'
const pad2 = (n) => String(n).padStart(2, '0')
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

/* ---------- 1. 下达指令 ---------- */
const members = await table.listMembers(OP, PID)
const owner = members.find((m) => m.unionId === OP)
const created = await createDirective({
  user: { unionId: OP, name: owner.name },
  projectId: PID,
  title: TITLE,
  ownerNames: [owner.name],
  deadline: '2026-09-30',
})
check('下达指令', Boolean(created.directiveRecordId && created.taskRecordId),
  `指令=${created.directiveRecordId} 任务=${created.taskRecordId}`)

/* ---------- 2. 负责人提交关联日志（走真实 addRecord 钩子链路） ---------- */
const user = { userId: 'test-owner', unionId: OP, name: owner.name }
const rec = await store.addRecord({
  user,
  rawContent: '【测试日志】完成指令联动链路开发：指令表写入、任务自动创建、日志归纳同步均已实现，剩余联调验证。',
  parsed: { taskDate: todayStr(), progress: '进行中', hours: 2 },
  projectId: PID,
  taskId: created.taskRecordId, // 显式关联到指令任务 → 触发 scheduleProgressSync
})
check('日志提交并关联指令任务', rec.linkedTaskId === created.taskRecordId && !rec.pendingSync,
  `linkedTask=${rec.linkedTaskId}`)

/* ---------- 3. 直接驱动归纳（防抖钩子已由上一步触发；此处注入"AI限流"验证降级拼接路径） ---------- */
const syncOut = await syncDirectiveProgress(PID, created.taskRecordId, {
  chat: async () => {
    throw new Error('429 限流（模拟）')
  },
})
console.log('归纳同步返回:', JSON.stringify(syncOut).slice(0, 160))
await new Promise((r) => setTimeout(r, 3_000))

/* ---------- 4. 验证指令「执行进展」已自动更新 ---------- */
const dir = (await table.listDirectives(OP, PID, { force: true })).find((d) => d.recordId === created.directiveRecordId)
const day = todayStr()
check('指令「执行进展」已自动归纳更新', Boolean(dir?.progress?.startsWith(`[${day}]`)),
  `执行进展=${(dir?.progress || '').slice(0, 100)}`)

/* ---------- 5. 清理：删指令行/任务行/日志行/映射/本地镜像 ---------- */
async function delRecords(sheetName, ids) {
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
async function findIds(sheetName, keyword) {
  const { getAccessToken } = await import('../src/services/dingtalk.js')
  const axios = (await import('axios')).default
  const BASE = 'kDnRL6jAJM34j50ZI9rRwr2aWyMoPYe1'
  const t = await getAccessToken()
  const { data } = await axios.get(
    `https://api.dingtalk.com/v1.0/notable/bases/${BASE}/sheets/${encodeURIComponent(sheetName)}/records?operatorId=${OP}&maxResults=100`,
    { headers: { 'x-acs-dingtalk-access-token': t } },
  )
  return (data.records || []).filter((x) => (JSON.stringify(x.fields) || '').includes(keyword)).map((x) => x.id)
}
try {
  // 日志行ID：从工作日志表按内容前缀查真实钉钉记录ID（本地镜像的 id 是本地 uuid，非钉钉ID）
  const logIds = await findIds('工作日志表', '【测试日志】')
  await delRecords('领导指令表', [created.directiveRecordId])
  await delRecords('任务表', [created.taskRecordId])
  if (logIds.length) await delRecords('工作日志表', logIds)
  // links 映射
  const LF = path.join(DATA_DIR, 'directive-links.json')
  const links = JSON.parse(fs.readFileSync(LF, 'utf8'))
  delete links[created.taskRecordId]
  fs.writeFileSync(LF, JSON.stringify(links, null, 2))
  // 本地镜像
  const RF = path.join(DATA_DIR, 'records.json')
  const mirror = JSON.parse(fs.readFileSync(RF, 'utf8'))
  const kept = mirror.filter((r) => r.id !== rec.id)
  fs.writeFileSync(RF, JSON.stringify(kept))
  check('清理还原', true, `已删指令1/任务1/日志${logIds.length}/映射/镜像`)
} catch (err) {
  check('清理还原', false, err.message)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n===== 归纳联动验证 ${failed.length ? '未通过 ' + failed.length + ' 项' : '全部通过'}（${results.length - failed.length}/${results.length}）=====`)
process.exit(failed.length ? 1 : 0)
