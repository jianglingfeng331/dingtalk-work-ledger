import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 独立临时数据目录：测试不读写真实 data/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-test-'))
process.env.WORK_SERVER_DATA_DIR = tmp

const {
  mapTaskStatusToDirective,
  validateDirectiveInput,
  fallbackSummary,
  buildProgressPrompt,
  normalizeParsedDirective,
  directiveIdOfTask,
} = await import('../src/services/directive.js')

const pad2 = (n) => String(n).padStart(2, '0')
const dayOffset = (n) => {
  const d = new Date(Date.now() + n * 86400000)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

test('状态映射：已完成不判逾期', () => {
  assert.equal(mapTaskStatusToDirective('已完成', '2000-01-01'), '已完成')
})

test('状态映射：未完成且逾期 → 已延期', () => {
  assert.equal(mapTaskStatusToDirective('进行中', dayOffset(-1)), '已延期')
  assert.equal(mapTaskStatusToDirective('未开始', '2000-01-01'), '已延期')
})

test('状态映射：未逾期保持任务状态', () => {
  assert.equal(mapTaskStatusToDirective('进行中', dayOffset(1)), '进行中')
  assert.equal(mapTaskStatusToDirective('未开始', dayOffset(30)), '未开始')
})

test('状态映射：办结时限当天不算逾期', () => {
  assert.equal(mapTaskStatusToDirective('进行中', dayOffset(0)), '进行中')
})

test('状态映射：空状态→未开始；未知状态→进行中（无时限兜底）', () => {
  assert.equal(mapTaskStatusToDirective('', ''), '未开始')
  assert.equal(mapTaskStatusToDirective('挂起', dayOffset(30)), '进行中')
})

test('指令入参校验：必填项', () => {
  assert.match(validateDirectiveInput({ title: '', deadline: '2026-01-01', owners: ['张三'] }), /任务名称/)
  assert.match(validateDirectiveInput({ title: 'x'.repeat(51), deadline: '2026-01-01', owners: ['张三'] }), /50字/)
  assert.match(validateDirectiveInput({ title: '任务', deadline: '', owners: ['张三'] }), /办结时限/)
  assert.match(validateDirectiveInput({ title: '任务', deadline: '2026/01/01', owners: ['张三'] }), /办结时限/)
  assert.match(validateDirectiveInput({ title: '任务', deadline: '2026-01-01', owners: [] }), /负责人/)
  assert.equal(validateDirectiveInput({ title: '任务', deadline: '2026-01-01', owners: ['张三'] }), '')
})

test('进展兜底归纳：按人分条拼接', () => {
  const out = fallbackSummary([
    { recorder: '张三', rawContent: '完成方案设计' },
    { recorder: '李四', rawContent: '接口联调' },
    { recorder: '张三', rawContent: '提交代码' },
  ])
  assert.ok(out.includes('张三：完成方案设计；提交代码'))
  assert.ok(out.includes('李四：接口联调'))
})

test('进展兜底归纳：超长截断不爆字段', () => {
  const out = fallbackSummary([{ recorder: '张三', rawContent: '长'.repeat(1000) }])
  assert.ok(out.length <= 500)
})

test('进展归纳Prompt：包含指令名与日志内容', () => {
  const p = buildProgressPrompt('平台采购招标', [
    { recorder: '王五', rawContent: '与供应商核对报价', progress: '进行中', hours: 3 },
  ])
  assert.ok(p.includes('平台采购招标'))
  assert.ok(p.includes('与供应商核对报价'))
  assert.ok(p.includes('王五'))
})

test('无关联任务时指令ID查询返回空', () => {
  assert.equal(directiveIdOfTask('not-exist-task'), '')
})

test('指令解析归一化：人名过滤成员表、去重、保序', () => {
  const out = normalizeParsedDirective(
    { title: '平台升级', owners: ['张三', '不存在的人', '李四', '张三'], deadline: '2026-09-30', status: '进行中' },
    ['张三', '李四', '王五'],
  )
  assert.deepEqual(out.owners, ['张三', '李四'])
  assert.equal(out.status, '进行中')
  assert.equal(out.deadline, '2026-09-30')
})

test('指令解析归一化：非法状态回落未开始、非法日期置空', () => {
  const out = normalizeParsedDirective(
    { title: 'x', owners: [], deadline: '9月30日', status: '已取消' },
    ['张三'],
  )
  assert.equal(out.status, '未开始')
  assert.equal(out.deadline, '')
})

test('指令解析归一化：AI未给标题回落原文（50字截断）', () => {
  const raw = '请让张三在本月底前完成智慧园区平台一期项目的全部联调与验收准备工作'.repeat(3)
  const out = normalizeParsedDirective({ owners: [], deadline: '', status: '' }, ['张三'], raw)
  assert.equal(out.title, raw.slice(0, 50))
  // 降级路径（AI失败）：空对象也回落原文
  const fallback = normalizeParsedDirective({}, ['张三'], '简单指令')
  assert.equal(fallback.title, '简单指令')
  assert.equal(fallback.status, '未开始')
})

test('指令解析归一化：空/异常输入不抛错', () => {
  const out = normalizeParsedDirective(null, undefined, '')
  assert.deepEqual(out, { title: '', owners: [], deadline: '', status: '未开始' })
})
