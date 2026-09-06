/**
 * 自动建表服务：新建项目时自动创建AI表格文档（docType=BASE）+ 四张标准数据表
 * 落点解析（已实测验证）：先按名称匹配团队知识库；未命中则查操作人「我的文档」根目录同名文件夹
 * 链路：wiki2.0列知识库/我的文档 → 建 BASE 文档（baseId=dentryUuid，与 URL 提取口径一致）→ 逐张建数据表
 * 依赖权限：知识库读、知识库节点读、知识库文档写、AI表格应用读/写
 */
import axios from 'axios'
import { getAccessToken } from './dingtalk.js'

const HTTP = axios.create({ timeout: 15000 })
const headers = async () => ({
  'x-acs-dingtalk-access-token': await getAccessToken(),
  'Content-Type': 'application/json',
})

/** 新项目AI表格的落点名称：团队知识库或「我的文档」内的文件夹（环境变量可覆盖） */
export const DEFAULT_WORKSPACE_NAME = process.env.TABLE_WORKSPACE_NAME || '秒建功项目管理'

/** 四张数据表标准模板（与 dingtalk-table.js 读写的真实表头 1:1 一致）
 *  注意：每个 sheet 首列为主字段（仅支持 text 等少数类型），选项类列必须带 choices */
function sheetTemplates(sheetNames = {}) {
  return [
    {
      name: sheetNames.log || '工作日志表',
      fields: [
        { name: '日期', type: 'date', property: { formatter: 'YYYY-MM-DD' } },
        { name: '成员', type: 'user', property: { multiple: false } },
        { name: '所属小组', type: 'singleSelect' },
        { name: '工作内容', type: 'text' },
        { name: '耗时', type: 'number', property: { formatter: 'FLOAT_1' } },
        { name: '关联任务', type: 'text' },
        { name: '产出物', type: 'text' },
        {
          name: '完成情况',
          type: 'singleSelect',
          property: { choices: [{ name: '未开始' }, { name: '进行中' }, { name: '已完成' }] },
        },
      ],
    },
    {
      name: sheetNames.task || '任务表',
      fields: [
        { name: '任务名称', type: 'text' },
        { name: '负责人', type: 'user', property: { multiple: false } },
        { name: '参与人', type: 'user', property: { multiple: true } },
        {
          name: '状态',
          type: 'singleSelect',
          property: { choices: [{ name: '未开始' }, { name: '进行中' }, { name: '已完成' }] },
        },
        { name: '计划节点', type: 'date', property: { formatter: 'YYYY-MM-DD' } },
        {
          name: '任务分类',
          type: 'singleSelect',
          property: { choices: ['项目管理', '客户沟通', '技术研发', '前端部署', '其它'].map((name) => ({ name })) },
        },
      ],
    },
    {
      name: sheetNames.member || '项目成员表',
      fields: [
        { name: '姓名', type: 'text' },
        { name: '通讯录用户', type: 'user', property: { multiple: false } },
        { name: '角色', type: 'multipleSelect' },
      ],
    },
    {
      name: sheetNames.directive || '领导指令表',
      fields: [
        { name: '任务名称', type: 'text' },
        { name: '提出日期', type: 'date', property: { formatter: 'YYYY-MM-DD HH:mm' } },
        { name: '负责人', type: 'user', property: { multiple: true } },
        { name: '办结时限', type: 'date', property: { formatter: 'YYYY-MM-DD' } },
        {
          name: '状态',
          type: 'singleSelect',
          property: { choices: [{ name: '未开始' }, { name: '进行中' }, { name: '已完成' }, { name: '已延期' }] },
        },
        { name: '执行进展', type: 'text' },
      ],
    },
  ]
}

/** 解析落点：同名团队知识库 → 「我的文档」根目录同名文件夹 → 都没有则报错并附可见清单 */
async function resolveWorkspace(operatorUnionId, workspaceName) {
  const seen = []
  // 1) 团队知识库（分页）
  try {
    let nextToken = ''
    do {
      const q = `operatorId=${operatorUnionId}&maxResults=30${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`
      const { data } = await HTTP.get(`https://api.dingtalk.com/v2.0/wiki/workspaces?${q}`, { headers: await headers() })
      const batch = Array.isArray(data?.workspaces) ? data.workspaces : Array.isArray(data?.workspace) ? data.workspace : []
      for (const ws of batch) {
        if (!ws?.workspaceId) continue
        seen.push(ws.name || '未命名')
        if (String(ws.name || '').includes(workspaceName)) {
          return { workspaceId: ws.workspaceId, parentNodeId: '', where: `知识库「${ws.name}」` }
        }
      }
      nextToken = data?.nextToken || ''
    } while (nextToken)
  } catch (err) {
    console.warn('[table-factory] 列团队知识库失败（转查我的文档）:', err?.response?.status, err?.message)
  }

  // 2) 我的文档（PERSONAL）：根目录找同名文件夹
  try {
    const { data: mine } = await HTTP.get(`https://api.dingtalk.com/v2.0/wiki/mineWorkspaces?operatorId=${operatorUnionId}`, {
      headers: await headers(),
    })
    const pw = mine?.workspace || {}
    if (pw.workspaceId && pw.rootNodeId) {
      let nextToken = ''
      do {
        const q = `parentNodeId=${pw.rootNodeId}&operatorId=${operatorUnionId}&maxResults=50${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`
        const { data } = await HTTP.get(`https://api.dingtalk.com/v2.0/wiki/nodes?${q}`, { headers: await headers() })
        const batch = Array.isArray(data?.nodes) ? data.nodes : Array.isArray(data?.node) ? data.node : []
        for (const n of batch) {
          if (!n?.nodeId) continue
          if (String(n.name || '').includes(workspaceName)) {
            return { workspaceId: pw.workspaceId, parentNodeId: n.nodeId, where: `我的文档文件夹「${n.name}」` }
          }
        }
        nextToken = data?.nextToken || ''
      } while (nextToken)
    }
  } catch (err) {
    console.warn('[table-factory] 查我的文档失败:', err?.response?.status, err?.message)
  }

  throw new Error(`未找到落点「${workspaceName}」：没有同名团队知识库，我的文档里也没有同名文件夹（可见知识库：${seen.join('、') || '无'}）`)
}

/** 在知识库/文件夹内创建一篇AI表格文档（docType=BASE），baseId=dentryUuid（与现有项目 URL 提取口径一致） */
async function createBaseDoc(ws, projectName, operatorUnionId) {
  const body = { name: projectName, docType: 'BASE', operatorId: operatorUnionId }
  if (ws.parentNodeId) body.parentNodeId = ws.parentNodeId
  const { data } = await HTTP.post(`https://api.dingtalk.com/v1.0/doc/workspaces/${ws.workspaceId}/docs`, body, {
    headers: await headers(),
  })
  const baseId = data?.dentryUuid
  if (!baseId) throw new Error(`创建AI表格文档返回异常：${JSON.stringify(data).slice(0, 120)}`)
  return { baseId, url: data.url || '', nodeId: baseId }
}

/** 删除知识库文档（建表中途失败时清理半成品，best-effort） */
async function deleteDoc(ws, nodeId, operatorUnionId) {
  try {
    await HTTP.delete(`https://api.dingtalk.com/v1.0/doc/workspaces/${ws.workspaceId}/docs/${nodeId}?operatorId=${operatorUnionId}`, {
      headers: await headers(),
    })
  } catch {
    /* 清理失败不影响主流程报错 */
  }
}

/** 在 base 内建一张数据表（含全部字段） */
async function createSheet(baseId, sheet, operatorUnionId) {
  const { data } = await HTTP.post(
    `https://api.dingtalk.com/v1.0/notable/bases/${baseId}/sheets?operatorId=${operatorUnionId}`,
    { name: sheet.name, fields: sheet.fields },
    { headers: await headers() },
  )
  return data?.id || ''
}

/**
 * 创建项目全套表格（导出）
 * @param {object} opts { projectName, sheetNames:{log,task,member,directive}, operatorUnionId, workspaceName? }
 * @returns {Promise<{baseId, url, where}>}
 * 中途失败会尽力删除半成品文档，避免留下空表格
 */
export async function createProjectTables(opts = {}) {
  const projectName = String(opts.projectName || '').trim()
  if (!projectName) throw new Error('缺少项目名称')
  const operatorUnionId = String(opts.operatorUnionId || '').trim()
  if (!operatorUnionId) throw new Error('缺少操作人unionId')

  const workspaceName = String(opts.workspaceName || DEFAULT_WORKSPACE_NAME)
  const ws = await resolveWorkspace(operatorUnionId, workspaceName)
  const doc = await createBaseDoc(ws, projectName, operatorUnionId)
  try {
    const sheets = sheetTemplates(opts.sheetNames || {})
    const ids = []
    for (const s of sheets) ids.push(await createSheet(doc.baseId, s, operatorUnionId))
    console.log(`[table-factory] 自动建表完成: 项目=${projectName} 落点=${ws.where} base=${doc.baseId} sheets=${sheets.map((s) => s.name).join('/')}`)
    return { baseId: doc.baseId, url: doc.url, where: ws.where, sheetIds: ids }
  } catch (err) {
    await deleteDoc(ws, doc.nodeId, operatorUnionId)
    const msg = err?.response?.data?.message || err?.message || '未知错误'
    throw new Error(`数据表创建失败（已回滚半成品表格）：${msg}`)
  }
}
