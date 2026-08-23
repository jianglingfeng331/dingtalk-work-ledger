<script setup>
import { computed, onActivated, onMounted, ref } from 'vue'
import { showFailToast } from 'vant'
import { getTaskLogs, getTasks } from '../api'
import { fmtDate } from '../utils/format'
import { initUser } from '../utils/user'
import { projectStore, loadMyProjects } from '../utils/project'

/* 任务视图：任务卡片常驻紧凑展示（工时/日志数徽标），
 * 点卡片才展开关联日志（懒加载+缓存），避免长列表撑爆页面 */
const enabled = ref(true)
const tasks = ref([])
const loading = ref(false)
const expandedId = ref('') // 当前展开的任务
const logsMap = ref({}) // taskId -> 日志列表缓存
const logsLoading = ref({}) // taskId -> loading

const STATUS_META = {
  已完成: { color: '#07c160', bg: 'rgba(7,193,96,.1)' },
  进行中: { color: '#1677ff', bg: 'rgba(22,119,255,.1)' },
  未开始: { color: '#969799', bg: 'rgba(150,151,153,.12)' },
}
const statusStyle = (s) => STATUS_META[s] || STATUS_META['未开始']

/* ===================== 到期统计与重点展示 ===================== */
const DUE_SOON_DAYS = 3 // 距截止不足N天视为"即将到期"（需求阈值，按需调整）

/** 计划节点距今天数：今天=0，昨天=-1；无日期/格式异常返回 null */
const dayDiff = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return null
  const n = Math.round((Date.parse(d) - Date.parse(fmtDate())) / 86400000)
  return Number.isFinite(n) ? n : null
}

// 到期预警只针对未完成且已设计划节点的任务（已完成不预警）
const openTasks = computed(() => tasks.value.filter((t) => t.status !== '已完成' && dayDiff(t.planDate) != null))

// 已逾期：超截止日（最早的排前，最紧急一目了然）
const overdueList = computed(() =>
  openTasks.value.filter((t) => dayDiff(t.planDate) < 0).sort((a, b) => a.planDate.localeCompare(b.planDate)),
)

// 即将到期：距截止不足N天（含今天），最近到期的排前
const dueSoonList = computed(() =>
  openTasks.value
    .filter((t) => {
      const d = dayDiff(t.planDate)
      return d != null && d >= 0 && d < DUE_SOON_DAYS
    })
    .sort((a, b) => a.planDate.localeCompare(b.planDate)),
)

/** 截止日友好文案：今天到期 / 剩N天 / 超N天 */
function dueText(d) {
  const n = dayDiff(d)
  if (n == null) return ''
  if (n === 0) return '今天到期'
  return n > 0 ? `剩 ${n} 天` : `超 ${-n} 天`
}

async function load() {
  loading.value = true
  try {
    const res = await getTasks()
    enabled.value = res.enabled !== false
    tasks.value = res.tasks || []
    if (enabled.value && !tasks.value.length) return
    logsMap.value = {}
    expandedId.value = ''
  } catch (err) {
    showFailToast(err?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

/** 展开/收起：首次展开懒加载该任务日志并缓存 */
async function toggle(t) {
  if (expandedId.value === t.recordId) {
    expandedId.value = ''
    return
  }
  expandedId.value = t.recordId
  if (logsMap.value[t.recordId]) return
  logsLoading.value = { ...logsLoading.value, [t.recordId]: true }
  try {
    logsMap.value = { ...logsMap.value, [t.recordId]: (await getTaskLogs(t.recordId)) || [] }
  } catch (err) {
    showFailToast(err?.message || '日志加载失败')
  } finally {
    logsLoading.value = { ...logsLoading.value, [t.recordId]: false }
  }
}

onMounted(async () => {
  await initUser()
  await loadMyProjects() // 项目就绪后再查询（首次使用未存项目ID时自动选中默认项目）
  await load()
})
onActivated(() => {
  // keep-alive 返回本页时轻量刷新（新提交的日志即时可见）
  if (!loading.value) load()
})
</script>

<template>
  <div class="page">
    <header class="hd">
      <div class="hd-title">任务</div>
      <div class="hd-sub">{{ curProjectName ? `${curProjectName} · ` : '' }}共 {{ tasks.length }} 项 · 点卡片查看关联日志</div>
      <van-icon name="replay" class="hd-refresh" @click="load" />
    </header>

    <main class="body">
      <van-loading v-if="loading" class="tip" vertical>加载中...</van-loading>

      <van-empty v-else-if="!enabled" image="search" description="未连接钉钉AI表格，任务视图不可用" />

      <van-empty v-else-if="!tasks.length" image="search" description="任务表暂无任务" />

      <template v-else>
        <!-- 统计卡片：总数 / 即将到期 / 已逾期 -->
        <div class="stats-row">
          <div class="stat-card">
            <div class="stat-num">{{ tasks.length }}</div>
            <div class="stat-label">任务总数</div>
          </div>
          <div class="stat-card stat-soon">
            <div class="stat-num">{{ dueSoonList.length }}</div>
            <div class="stat-label">{{ DUE_SOON_DAYS }}天内到期</div>
          </div>
          <div class="stat-card stat-overdue">
            <div class="stat-num">{{ overdueList.length }}</div>
            <div class="stat-label">已逾期</div>
          </div>
        </div>

        <!-- 重点展示：逾期（红）/ 即将到期（黄），未完成且有计划节点的任务 -->
        <div v-if="overdueList.length" class="focus-block overdue">
          <div class="focus-title"><van-icon name="warning-o" /> 已逾期 {{ overdueList.length }} 项</div>
          <div v-for="t in overdueList" :key="t.recordId" class="focus-item">
            <span class="fi-name">{{ t.title }}</span>
            <span class="fi-meta">
              {{ t.owner || '未指派' }} · 截止 {{ t.planDate }} ·
              <em class="fi-due">{{ dueText(t.planDate) }}</em>
            </span>
          </div>
        </div>

        <div v-if="dueSoonList.length" class="focus-block soon">
          <div class="focus-title"><van-icon name="clock-o" /> {{ DUE_SOON_DAYS }}天内到期 {{ dueSoonList.length }} 项</div>
          <div v-for="t in dueSoonList" :key="t.recordId" class="focus-item">
            <span class="fi-name">{{ t.title }}</span>
            <span class="fi-meta">
              {{ t.owner || '未指派' }} · 截止 {{ t.planDate }} ·
              <em class="fi-due">{{ dueText(t.planDate) }}</em>
            </span>
          </div>
        </div>

        <section
          v-for="t in tasks"
          :key="t.recordId"
          class="card"
          :class="{ open: expandedId === t.recordId }"
          @click="toggle(t)"
        >
          <div class="card-top">
            <div class="name">{{ t.title }}</div>
            <span class="status" :style="statusStyle(t.status)">{{ t.status || '未开始' }}</span>
          </div>

          <div class="meta">
            <span v-if="t.owner"><van-icon name="manager-o" /> {{ t.owner }}</span>
            <span v-if="t.planDate"><van-icon name="clock-o" /> {{ t.planDate }}</span>
            <span class="grow" />
            <span class="badge badge-hour"><van-icon name="clock-o" /> {{ t.totalHours || 0 }}h</span>
            <span class="badge"><van-icon name="notes-o" /> {{ t.logCount || 0 }}条</span>
          </div>

          <!-- 关联日志（展开态，阻止冒泡避免点日志收起） -->
          <div v-if="expandedId === t.recordId" class="logs" @click.stop>
            <van-loading v-if="logsLoading[t.recordId]" size="18" vertical>加载日志...</van-loading>
            <div v-else-if="!(logsMap[t.recordId] || []).length" class="logs-empty">暂无关联日志</div>
            <div v-for="log in logsMap[t.recordId] || []" :key="log.id" class="log">
              <div class="log-hd">
                <span class="log-date">{{ log.taskDate }}</span>
                <span class="log-who">{{ log.recorder }}</span>
                <span v-if="log.hours != null" class="log-hours">{{ log.hours }}h</span>
              </div>
              <div class="log-content">{{ log.rawContent }}</div>
            </div>
          </div>

          <div class="toggle-hint">
            <van-icon :name="expandedId === t.recordId ? 'arrow-up' : 'arrow-down'" />
            {{ expandedId === t.recordId ? '收起' : '查看关联日志' }}
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
}

.hd {
  flex-shrink: 0;
  position: relative;
  padding: 14px 16px 10px;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
}
.hd-title {
  font-size: 18px;
  font-weight: 600;
}
.hd-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #969799;
}
.hd-refresh {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 20px;
  color: #969799;
  padding: 8px;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 12px calc(70px + env(safe-area-inset-bottom));
}
.tip {
  margin-top: 40px;
}

/* 统计卡片：三等分自适应（grid），数字大标签小，颜色区分状态 */
.stats-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 10px;
}
.stat-card {
  background: #fff;
  border-radius: 12px;
  padding: 12px 4px 10px;
  text-align: center;
  min-width: 0; /* 允许窄屏压缩 */
}
.stat-num {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  color: #323233;
}
.stat-label {
  margin-top: 3px;
  font-size: 11px;
  color: #969799;
  white-space: nowrap;
}
.stat-soon {
  background: #fff8f2; /* 黄/橙：即将到期 */
}
.stat-soon .stat-num {
  color: #ff9760;
}
.stat-overdue {
  background: #fef2f2; /* 红：已逾期 */
}
.stat-overdue .stat-num {
  color: #ee0a24;
}

/* 重点展示区：逾期/即将到期明细（名称+负责人+截止日） */
.focus-block {
  background: #fff;
  border-radius: 12px;
  padding: 10px 14px;
  margin-bottom: 10px;
  border-left: 3px solid transparent;
}
.focus-block.overdue {
  border-left-color: #ee0a24;
}
.focus-block.soon {
  border-left-color: #ff9760;
}
.focus-title {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
}
.focus-block.overdue .focus-title {
  color: #ee0a24;
}
.focus-block.soon .focus-title {
  color: #ff9760;
}
.focus-item {
  padding: 7px 0;
  border-top: 1px dashed #ebedf0;
}
.focus-item:first-of-type {
  margin-top: 6px;
}
.fi-name {
  display: block;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  word-break: break-all;
  color: #323233;
}
.fi-meta {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: #969799;
  word-break: break-all;
}
.fi-due {
  font-style: normal;
  font-weight: 600;
}
.focus-block.overdue .fi-due {
  color: #ee0a24;
}
.focus-block.soon .fi-due {
  color: #ff9760;
}

.card {
  background: #fff;
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 10px;
  transition: box-shadow 0.2s;
}
.card.open {
  box-shadow: 0 2px 12px rgba(22, 119, 255, 0.12);
}

.card-top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.name {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  word-break: break-all;
}
.status {
  flex-shrink: 0;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
}

.meta {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #969799;
  flex-wrap: wrap;
}
.meta .grow {
  flex: 1;
}
.meta .van-icon {
  font-size: 13px;
  vertical-align: -2px;
}
.badge {
  background: rgba(22, 119, 255, 0.08);
  color: #1677ff;
  border-radius: 10px;
  padding: 2px 8px;
}
.badge-hour {
  background: rgba(255, 153, 0, 0.1);
  color: #ff976a;
}

.logs {
  margin-top: 10px;
  border-top: 1px dashed #ebedf0;
  padding-top: 10px;
}
.logs-empty {
  font-size: 13px;
  color: #969799;
  text-align: center;
  padding: 10px 0;
}
.log {
  background: #f7f8fa;
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.log-hd {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #969799;
}
.log-who {
  color: #323233;
}
.log-hours {
  color: #ff976a;
}
.log-content {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.5;
  color: #323233;
  word-break: break-all;
}

.toggle-hint {
  margin-top: 8px;
  text-align: center;
  font-size: 12px;
  color: #1677ff;
}
</style>
