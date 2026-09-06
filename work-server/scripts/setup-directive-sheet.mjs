/**
 * 一次性运维脚本：领导指令表初始化 + 会议待办表清理
 * 用法：
 *   node scripts/setup-directive-sheet.mjs --list                        # 仅列出 base 中所有数据表
 *   node scripts/setup-directive-sheet.mjs --create                      # 创建「领导指令表」（已存在则跳过）
 *   node scripts/setup-directive-sheet.mjs --backup-meeting              # 备份「会议待办表」全部记录到 data/
 *   node scripts/setup-directive-sheet.mjs --delete-meeting              # 删除「会议待办表」（删前自动备份）
 * 凭据取自 .env；baseId/operatorUnionId 取自 data/settings.json 第一个启用表格的项目
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import { getAccessToken } from '../src/services/dingtalk.js'
import { DATA_DIR } from '../src/services/settings.js'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)

const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'))
const proj = (settings.projects || []).find((p) => p.baseId) || {}
const BASE = proj.baseId
const OP = proj.operatorUnionId || settings.table?.operatorUnionId || ''
if (!BASE || !OP) {
  console.error('缺少 baseId/operatorUnionId（检查 data/settings.json）')
  process.exit(1)
}
console.log(`base=${BASE} operator=${OP}`)

const HTTP = axios.create({ timeout: 20000 })
const headers = async () => ({ 'x-acs-dingtalk-access-token': await getAccessToken(), 'Content-Type': 'application/json' })
const root = `https://api.dingtalk.com/v1.0/notable/bases/${BASE}/sheets`

/** 列出 base 中所有数据表 */
async function listSheets() {
  const { data } = await HTTP.get(`${root}?operatorId=${encodeURIComponent(OP)}`, { headers: await headers() })
  return data?.value || data?.sheets || []
}

/** 分页拉取指定表全部记录 */
async function listRecords(sheetName) {
  const out = []
  let nextToken = ''
  do {
    let q = `operatorId=${encodeURIComponent(OP)}&maxResults=100`
    if (nextToken) q += `&nextToken=${encodeURIComponent(nextToken)}`
    const { data } = await HTTP.get(`${root}/${encodeURIComponent(sheetName)}/records?${q}`, { headers: await headers() })
    out.push(...(data?.records || []))
    nextToken = data?.nextToken || ''
  } while (nextToken)
  return out
}

const DIR_NAME = '领导指令表'

/* ---------- 阶段1：列表现状 ---------- */
if (has('--list') || args.length === 0) {
  const sheets = await listSheets()
  console.log(`\n共 ${sheets.length} 张数据表：`)
  for (const s of sheets) console.log(`  - ${s.name} (${s.id})`)
}

const NEW_FIELDS = [
  { name: '任务名称', type: 'text' },
  { name: '提出日期', type: 'date', property: { formatter: 'YYYY-MM-DD HH:mm' } },
  { name: '负责人', type: 'user', property: { multiple: true } },
  { name: '办结时限', type: 'date', property: { formatter: 'YYYY-MM-DD' } },
  {
    name: '状态',
    type: 'singleSelect',
    property: { choices: ['未开始', '进行中', '已完成', '已延期'].map((name) => ({ name })) },
  },
  { name: '执行进展', type: 'text' },
]

async function createSheet() {
  const { data } = await HTTP.post(
    `${root}?operatorId=${encodeURIComponent(OP)}`,
    { name: DIR_NAME, fields: NEW_FIELDS },
    { headers: await headers() },
  )
  console.log(`✅ 「${DIR_NAME}」创建成功:`, JSON.stringify(data))
  return data
}

/* ---------- 阶段2：创建领导指令表 ---------- */
if (has('--create')) {
  const sheets = await listSheets()
  if (sheets.some((s) => s.name === DIR_NAME)) {
    console.log(`「${DIR_NAME}」已存在，跳过创建`)
  } else {
    await createSheet()
  }
}

/* ---------- 阶段2b：旧结构指令表重建（备份→删除→按新结构重建→迁移记录） ---------- */
if (has('--recreate-directive')) {
  const sheets = await listSheets()
  const old = sheets.find((s) => s.name === DIR_NAME)
  if (!old) {
    console.log(`「${DIR_NAME}」不存在，直接创建`)
    await createSheet()
  } else {
    // 1) 备份旧表全部记录
    const oldRecords = await listRecords(old.name)
    const stamp = new Date().toISOString().slice(0, 10)
    const file = path.join(DATA_DIR, `backup-领导指令表-旧-${stamp}.json`)
    fs.writeFileSync(file, JSON.stringify({ sheet: old, records: oldRecords, exportedAt: new Date().toISOString() }, null, 2))
    console.log(`📦 旧表 ${oldRecords.length} 条记录已备份 → ${file}`)

    // 2) 删除旧表
    const del = await HTTP.delete(`${root}/${encodeURIComponent(old.name)}?operatorId=${encodeURIComponent(OP)}`, {
      headers: await headers(),
    })
    console.log(`🗑️ 旧表删除:`, JSON.stringify(del.data))

    // 3) 新结构重建
    await createSheet()
    await new Promise((r) => setTimeout(r, 2000)) // 等表初始化完成

    // 4) 迁移旧记录：指令内容→任务名称、执行人→负责人、已执行/已确认→已完成、执行反馈→执行进展
    const toText = (v) => (Array.isArray(v) ? v.map((x) => x?.text ?? x).join('') : v == null ? '' : String(v))
    const toDate = (v) => (typeof v === 'number' ? v : toText(v).slice(0, 10) || null)
    const STATUS_MAP = { 待执行: '未开始', 已执行: '已完成', 已确认: '已完成', 已延期: '已延期' }
    const rows = oldRecords
      .map((r) => {
        const f = r.fields || {}
        const title = toText(f['指令内容'] ?? f['任务名称']).trim()
        if (!title) return null
        const owners = Array.isArray(f['执行人'] ?? f['负责人'])
          ? (f['执行人'] ?? f['负责人']).filter((m) => m?.unionId).map((m) => ({ unionId: m.unionId }))
          : []
        const fields = {
          任务名称: title,
          提出日期: toDate(f['提出日期']) || Date.now(),
          办结时限: toDate(f['办结时限']) || toText(f['办结时限']).slice(0, 10),
          状态: STATUS_MAP[f['状态']?.name] || '进行中',
        }
        if (owners.length) fields.负责人 = owners
        const fb = toText(f['执行反馈'] ?? f['执行进展']).trim()
        if (fb) fields.执行进展 = fb
        return { fields }
      })
      .filter(Boolean)
    if (rows.length) {
      for (let i = 0; i < rows.length; i += 10) {
        const { data } = await HTTP.post(
          `${root}/${encodeURIComponent(DIR_NAME)}/records?operatorId=${encodeURIComponent(OP)}`,
          { records: rows.slice(i, i + 10) },
          { headers: await headers() },
        )
        console.log(`📥 已迁移 ${Math.min(i + 10, rows.length)}/${rows.length} 条`)
      }
    } else {
      console.log('旧表无有效记录，无需迁移')
    }
  }
}

/* ---------- 阶段3：备份会议待办表 ---------- */
async function backupMeeting() {
  const sheets = await listSheets()
  const target = sheets.find((s) => (s.name || '').includes('会议待办'))
  if (!target) return null
  const records = await listRecords(target.name)
  const file = path.join(DATA_DIR, `backup-会议待办表-${new Date().toISOString().slice(0, 10)}.json`)
  fs.writeFileSync(file, JSON.stringify({ sheet: target, records, exportedAt: new Date().toISOString() }, null, 2))
  console.log(`📦 已备份 ${records.length} 条记录 → ${file}`)
  return target
}

if (has('--backup-meeting')) await backupMeeting()

/* ---------- 阶段4：删除会议待办表（删前强制备份） ---------- */
if (has('--delete-meeting')) {
  const target = (await backupMeeting()) || (await (await listSheets()).find?.(() => null))
  if (!target) {
    console.log('未找到「会议待办表」，无需删除')
  } else {
    const { data } = await HTTP.delete(
      `${root}/${encodeURIComponent(target.name)}?operatorId=${encodeURIComponent(OP)}`,
      { headers: await headers() },
    )
    console.log(`🗑️ 「${target.name}」删除结果:`, JSON.stringify(data))
  }
}
