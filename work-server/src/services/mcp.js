import { listRecords } from './store.js'
import { listMembers, listTasks } from './dingtalk-table.js'

/**
 * MCP（Model Context Protocol）工具层
 * 以 MCP 风格定义台账数据工具，AI 查询流程通过 callTool 获取实时业务上下文，
 * 再拼接 Prompt 交给千问推理 —— 数据与模型解耦，后续可无缝切换为独立 MCP Server。
 */
const tools = [
  {
    name: 'get_work_records',
    description: '查询项目工作台账记录，返回结构化任务列表（含记录人、进度、任务日期、标签）',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'today', 'week', 'undone'], description: '查询范围' },
        team: { type: 'boolean', description: '是否查询全员数据（仅管理员可用）' },
      },
    },
    handler: ({ user, scope = 'all', team = false }) =>
      listRecords({ user, scope, team: team && user.isAdmin, projectId: user.projectId }),
  },
  {
    name: 'get_work_stats',
    description: '获取台账统计概览：个人或团队的记录数、完成率、各进度分布、各成员工作量',
    inputSchema: {
      type: 'object',
      properties: { team: { type: 'boolean', description: '是否统计全员数据（仅管理员可用）' } },
    },
    handler: ({ user, team = false }) => {
      return listRecords({ user, scope: 'all', team: team && user.isAdmin, projectId: user.projectId }).then((records) => {
        const byProgress = { 已完成: 0, 进行中: 0, 未开始: 0 }
        const byMember = {}
        const byTag = {}
        records.forEach((r) => {
          byProgress[r.progress] = (byProgress[r.progress] || 0) + 1
          byMember[r.recorder] = (byMember[r.recorder] || 0) + 1
          r.tags?.forEach((t) => (byTag[t] = (byTag[t] || 0) + 1))
        })
        const done = byProgress['已完成'] || 0
        return {
          total: records.length,
          doneRate: records.length ? Math.round((done / records.length) * 100) : 0,
          byProgress,
          byMember,
          byTag,
        }
      })
    },
  },
  {
    // 任务表实时拉取（钉钉AI表格）；失败由调用方容错，不阻断AI查询
    name: 'get_tasks',
    description: '查询项目任务表（工作安排）：任务名、负责人、状态、计划节点、任务分类',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: '按负责人姓名过滤（可选）' } },
    },
    handler: async ({ user, owner = '' }) => {
      const tasks = await listTasks(user.unionId, user.projectId)
      return owner ? tasks.filter((t) => t.owner?.includes(owner)) : tasks
    },
  },
  {
    name: 'get_members',
    description: '查询项目成员表：成员姓名与角色',
    inputSchema: { type: 'object', properties: {} },
    handler: ({ user }) => listMembers(user.unionId, user.projectId),
  },
]

const registry = new Map(tools.map((t) => [t.name, t]))

/** 调用 MCP 工具：供 AI 查询链路获取实时台账数据 */
export async function callTool(name, params = {}) {
  const tool = registry.get(name)
  if (!tool) throw new Error(`MCP工具不存在: ${name}`)
  return tool.handler(params)
}

/** 工具描述符（输出给日志/未来注册到真实 MCP Server 用） */
export function toolSchemas() {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}
