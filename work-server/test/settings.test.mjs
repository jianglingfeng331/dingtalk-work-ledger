import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 独立临时数据目录：测试不读写真实 data/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-settings-test-'))
process.env.WORK_SERVER_DATA_DIR = tmp

const settings = await import('../src/services/settings.js')

test('新建项目：leaders 随项目持久化', () => {
  const p = settings.saveProject({
    name: '测试项目',
    baseId: 'base_test_001',
    leaders: [
      { name: '张三', unionId: 'union_zs' },
      { name: '李四', unionId: '' },
    ],
  })
  assert.ok(p.id)
  assert.equal(p.leaders.length, 2)
  const again = settings.getProject(p.id)
  assert.equal(again.leaders[0].unionId, 'union_zs')
})

test('isLeader：unionId 精确命中 / userId 兜底 / 未配置为否', () => {
  const p = settings.saveProject({
    name: '领导判定项目',
    baseId: 'base_test_002',
    leaders: [
      { name: '王五', unionId: 'union_ww', userId: 'user_ww' },
      { name: '赵六', unionId: '', userId: 'user_zl' },
    ],
  })
  assert.equal(settings.isLeader({ unionId: 'union_ww', userId: 'x' }, p.id), true)
  assert.equal(settings.isLeader({ unionId: '', userId: 'user_zl' }, p.id), true)
  assert.equal(settings.isLeader({ unionId: 'union_other', userId: 'other' }, p.id), false)
  assert.equal(settings.isLeader({ unionId: 'union_ww' }, '不存在的项目'), false)
  assert.equal(settings.isLeader(null, p.id), false)
})

test('更新项目：不传 leaders 不清空已有配置（增量合并语义）', () => {
  const p = settings.saveProject({ name: '合并项目', baseId: 'base_test_003', leaders: [{ name: '钱七', unionId: 'u_qq' }] })
  settings.saveProject({ id: p.id, name: '合并项目改' })
  const after = settings.getProject(p.id)
  assert.equal(after.name, '合并项目改')
  assert.equal(after.leaders.length, 1)
  assert.equal(after.leaders[0].name, '钱七')
})

test('指令表名默认值：未配置回落「领导指令表」', () => {
  const p = settings.saveProject({ name: '默认表名项目', baseId: 'base_test_004' })
  const t = settings.getTable(p.id)
  assert.equal(t.directiveSheetName, '领导指令表')
  assert.equal(t.taskSheetName, '任务表')
})

test('管理员判定不受项目 leaders 影响（两个独立权限维度）', () => {
  const p = settings.saveProject({ name: '权限维度项目', baseId: 'base_test_005', leaders: [{ name: '管理员甲', unionId: 'u_admin' }] })
  // 管理员名单为空：非 local 来源用户不是管理员，即使他是领导
  assert.equal(settings.isAdmin('somebody', 'dingtalk'), false)
  assert.equal(settings.isLeader({ unionId: 'u_admin' }, p.id), true)
})

test('项目别名匹配：口语化叫法均可命中（大小写/标点容忍）', () => {
  const p = settings.saveProject({
    name: '城投AI协同',
    baseId: 'base_alias_001',
    aliases: ['城投ai项目', 'AI协同项目', '城投项目', 'ai项目'],
  })
  assert.equal(p.aliases.length, 4)
  // 别名命中（含大小写混合、口语句子）
  assert.equal(settings.matchProjectByText('城投ai项目')?.id, p.id)
  assert.equal(settings.matchProjectByText('AI协同项目')?.id, p.id)
  assert.equal(settings.matchProjectByText('嗯我们ai项目里面还有多少工作没完成')?.id, p.id)
  // 完整项目名命中
  assert.equal(settings.matchProjectByText('查一下城投AI协同的任务')?.id, p.id)
  // 未命中返回 null
  assert.equal(settings.matchProjectByText('别的项目'), null)
  assert.equal(settings.matchProjectByText(''), null)
})

test('项目别名：多项目时按包含内容命中各自项目，互不串扰', () => {
  const pb = settings.saveProject({ name: '智慧园区', baseId: 'base_alias_002', aliases: ['园区项目'] })
  assert.equal(settings.matchProjectByText('园区项目进展如何')?.id, pb.id)
  assert.equal(settings.matchProjectByText('随便问问')?.id, undefined)
})
