/**
 * 一次性探测脚本：验证「新建项目自动建表」全链路可行性
 * 1. wiki 2.0 新接口列知识库 → 按名称找落点 workspaceId
 * 2. docType=BASE 创建AI表格文档 → 拿 nodeId/docKey
 * 3. baseId 双候选(docKey/nodeId)自动试探 → 按 1:1 模板创建四张数据表
 * 4. 清理：删除探测文档
 * 运行：生产服务器 work-server 目录下 node scripts/probe-auto-table.mjs
 */
import 'dotenv/config'
import axios from 'axios'
import { getAccessToken } from '../src/services/dingtalk.js'

const OP = process.env.PROBE_OPERATOR || '9oWpUHcnbfoiE' // 操作人 unionId（默认项目管理员 jlf）
const WS_NAME = process.env.PROBE_WS_NAME || '秒建功项目管理'
const DOC_NAME = `探测-${Date.now().toString(36)}-可删除`

const HTTP = axios.create({ timeout: 15000 })
const h = async () => ({
  'x-acs-dingtalk-access-token': await getAccessToken(),
  'Content-Type': 'application/json',
})

/** 四张表 1:1 模板（与 dingtalk-table.js 读写的真实表头一致） */
const SHEETS = [
  {
    name: '工作日志表',
    fields: [
      { name: '日期', type: 'date', property: { formatter: 'YYYY-MM-DD' } },
      { name: '成员', type: 'user', property: { multiple: false } },
      { name: '所属小组', type: 'singleSelect' },
      { name: '工作内容', type: 'text' },
      { name: '耗时', type: 'number', property: { formatter: 'FLOAT_1' } },
      { name: '关联任务', type: 'text' },
      { name: '产出物', type: 'text' },
      { name: '完成情况', type: 'singleSelect', property: { choices: [{ name: '未开始' }, { name: '进行中' }, { name: '已完成' }] } },
    ],
  },
  {
    name: '任务表',
    fields: [
      { name: '任务名称', type: 'text' },
      { name: '负责人', type: 'user', property: { multiple: false } },
      { name: '参与人', type: 'user', property: { multiple: true } },
      { name: '状态', type: 'singleSelect', property: { choices: [{ name: '未开始' }, { name: '进行中' }, { name: '已完成' }] } },
      { name: '计划节点', type: 'date', property: { formatter: 'YYYY-MM-DD' } },
      { name: '任务分类', type: 'singleSelect', property: { choices: ['项目管理', '客户沟通', '技术研发', '前端部署', '其它'].map((name) => ({ name })) } },
    ],
  },
  {
    name: '项目成员表',
    fields: [
      { name: '姓名', type: 'text' },
      { name: '通讯录用户', type: 'user', property: { multiple: false } },
      { name: '角色', type: 'multipleSelect' },
    ],
  },
  {
    name: '领导指令表',
    fields: [
      { name: '任务名称', type: 'text' },
      { name: '提出日期', type: 'date', property: { formatter: 'YYYY-MM-DD HH:mm' } },
      { name: '负责人', type: 'user', property: { multiple: true } },
      { name: '办结时限', type: 'date', property: { formatter: 'YYYY-MM-DD' } },
      { name: '状态', type: 'singleSelect', property: { choices: [{ name: '未开始' }, { name: '进行中' }, { name: '已完成' }, { name: '已延期' }] } },
      { name: '执行进展', type: 'text' },
    ],
  },
]

async function main() {
  /* 1. wiki 2.0 列知识库（分页） */
  let target = null
  try {
    const list = []
    let nextToken = ''
    do {
      const q = `operatorId=${OP}&maxResults=30${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`
      const { data } = await HTTP.get(`https://api.dingtalk.com/v2.0/wiki/workspaces?${q}`, { headers: await h() })
      const batch = data?.workspaces || data?.workspace || []
      list.push(...(Array.isArray(batch) ? batch : []))
      nextToken = data?.nextToken || ''
    } while (nextToken)
    console.log('[1] 知识库列表:', list.map((x) => `${x.workspaceId}:${x.name}(${x.type})`).join(' | ') || '(空)')
    target = list.find((x) => String(x.name || '').includes(WS_NAME)) || null
  } catch (err) {
    console.log('[1] 列知识库失败:', err?.response?.status, JSON.stringify(err?.response?.data || err.message).slice(0, 300))
  }
  if (!target) {
    /* 我的文档（PERSONAL）里找落点文件夹：mineWorkspaces → 根节点列表按名称匹配 */
    console.log('[1b] 团队知识库未命中，转查我的文档…')
    try {
      const { data: mine } = await HTTP.get(`https://api.dingtalk.com/v2.0/wiki/mineWorkspaces?operatorId=${OP}`, { headers: await h() })
      const pw = mine?.workspace || {}
      console.log('[1b] 我的文档空间:', JSON.stringify({ workspaceId: pw.workspaceId, name: pw.name, type: pw.type, rootNodeId: pw.rootNodeId }))
      if (pw.workspaceId) {
        // 根节点下列目录（v2.0 wiki/nodes，parentNodeId=根节点dentryUuid）
        const nodesUrl = (token) =>
          `https://api.dingtalk.com/v2.0/wiki/nodes?parentNodeId=${pw.rootNodeId}&operatorId=${OP}&maxResults=50${token ? `&nextToken=${encodeURIComponent(token)}` : ''}`
        const nodes = []
        let token = ''
        try {
          do {
            const { data } = await HTTP.get(nodesUrl(token), { headers: await h() })
            const batch = data?.nodes || data?.node || []
            nodes.push(...(Array.isArray(batch) ? batch : []))
            token = data?.nextToken || ''
          } while (token)
          console.log('[1b] 根目录节点:', nodes.map((n) => `${n.nodeId}:${n.name}(${n.type})`).join(' | ') || '(空)')
          const folder = nodes.find((n) => String(n.name || '').includes(WS_NAME))
          if (folder) {
            target = { workspaceId: pw.workspaceId, name: pw.name, type: 'PERSONAL', parentNodeId: folder.nodeId }
            console.log(`[1b] 命中落点文件夹: ${WS_NAME} nodeId=${target.parentNodeId}`)
          }
        } catch (err) {
          console.log('[1b] 列节点失败:', err?.response?.status, JSON.stringify(err?.response?.data || err.message).slice(0, 250))
        }
      }
    } catch (err) {
      console.log('[1b] 获取我的文档空间失败:', err?.response?.status, JSON.stringify(err?.response?.data || err.message).slice(0, 300))
    }
  }
  if (!target) {
    console.log(`!! 未找到知识库/文件夹「${WS_NAME}」，终止`)
    return
  }
  console.log(`[1] 命中落点: ${target.workspaceId}(${target.name}, type=${target.type}${target.parentNodeId ? ', folder=' + target.parentNodeId : ''})`)

  /* 2. docType=BASE 创建AI表格文档 */
  let doc = null
  try {
    const body = { name: DOC_NAME, docType: 'BASE', operatorId: OP }
    if (target.parentNodeId) body.parentNodeId = target.parentNodeId
    const { data } = await HTTP.post(
      `https://api.dingtalk.com/v1.0/doc/workspaces/${target.workspaceId}/docs`,
      body,
      { headers: await h() },
    )
    doc = data
    console.log('[2] 创建BASE文档成功:', JSON.stringify(data))
  } catch (err) {
    console.log('[2] 创建BASE文档失败:', err?.response?.status, JSON.stringify(err?.response?.data || err.message).slice(0, 400))
    console.log('!! docType=BASE 不可用，自动建表需走兜底方案（手工建空表+API建四张数据表）')
    return
  }
  const nodeId = doc.nodeId || ''

  /* 3. baseId 候选试探（dentryUuid 优先，与现有项目 URL 提取口径一致）+ 建四张表 */
  const candidates = [doc.dentryUuid, doc.docKey, nodeId].filter(Boolean)
  const candName = (c) => (c === doc.dentryUuid ? 'dentryUuid' : c === doc.docKey ? 'docKey' : 'nodeId')
  let baseId = ''
  for (const c of candidates) {
    try {
      const { data } = await HTTP.post(
        `https://api.dingtalk.com/v1.0/notable/bases/${c}/sheets?operatorId=${OP}`,
        { name: SHEETS[0].name, fields: SHEETS[0].fields },
        { headers: await h() },
      )
      baseId = c
      console.log(`[3] baseId 候选命中: ${candName(c)}=${c} → 首表建成 id=${data?.id}`)
      break
    } catch (err) {
      console.log(`[3] baseId 候选失败(${candName(c)}=${c}):`, err?.response?.status, JSON.stringify(err?.response?.data || err.message).slice(0, 300))
    }
  }
  if (!baseId) {
    console.log('!! 两个候选都建不了表')
  } else {
    let ok = 1 // 首表已建
    for (const s of SHEETS.slice(1)) {
      try {
        const { data } = await HTTP.post(
          `https://api.dingtalk.com/v1.0/notable/bases/${baseId}/sheets?operatorId=${OP}`,
          { name: s.name, fields: s.fields },
          { headers: await h() },
        )
        console.log(`[3] 建表成功: ${s.name} → id=${data?.id}`)
        ok++
      } catch (err) {
        console.log(`[3] 建表失败: ${s.name} →`, err?.response?.status, JSON.stringify(err?.response?.data || err.message).slice(0, 400))
      }
    }
    console.log(`[3] 建表结果: ${ok}/${SHEETS.length}`)
  }

  /* 4. 清理探测文档（nodeId 参数优先用 dentryUuid，失败再试响应里的 nodeId） */
  let deleted = false
  for (const n of [doc.dentryUuid, nodeId].filter(Boolean)) {
    try {
      await HTTP.delete(`https://api.dingtalk.com/v1.0/doc/workspaces/${target.workspaceId}/docs/${n}?operatorId=${OP}`, { headers: await h() })
      console.log(`[4] 探测文档已删除（nodeId=${n}）`)
      deleted = true
      break
    } catch (err) {
      console.log(`[4] 删除尝试失败(${n.slice(0, 10)}…):`, err?.response?.status, JSON.stringify(err?.response?.data || err.message).slice(0, 150))
    }
  }
  if (!deleted) console.log('[4] 请手工删除探测文档:', doc.url)
}

main().catch((e) => {
  console.error('探测脚本异常:', e?.message)
  process.exit(1)
})
