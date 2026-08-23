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

/* 团队/我的 视图切换：统计卡、预警区、任务清单整体联动 */
const scope = ref('team') // 'team' 全部任务 | 'mine' 与我相关（负责人/参与人含本人）

function setScope(s) {
  if (scope.value === s || loading.value) return
  scope.value = s
  load()
}

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

/** 紧凑日期显示：MM-DD（预警区空间有限，年份省略） */
const shortDate = (d) => String(d || '').slice(5) || d

async function load() {
  loading.value = true
  try {
    const res = await getTasks(scope.value === 'mine' ? { mine: 1 } : {})
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
      <div class="hd-sub">
        {{ curProjectName ? `${curProjectName} · ` : '' }}{{ scope === 'mine' ? '我的' : '团队' }}共
        {{ tasks.length }} 项 · 点卡片查看关联日志
      </div>
      <van-icon name="replay" class="hd-refresh" @click="load" />
    </header>

    <main class="body">
      <!-- 团队/我的 滑动门切换：全部区域数据联动 -->
      <div v-if="enabled" class="scope-switch">
        <div class="scope-track">
          <span class="scope-thumb" :class="{ right: scope === 'mine' }" />
          <button type="button" :class="{ active: scope === 'team' }" @click="setScope('team')">团队</button>
          <button type="button" :class="{ active: scope === 'mine' }" @click="setScope('mine')">我的</button>
        </div>
      </div>

      <van-loading v-if="loading" class="tip" vertical>加载中...</van-loading>

      <van-empty v-else-if="!enabled" image="search" description="未连接钉钉AI表格，任务视图不可用" />

      <van-empty
        v-else-if="!tasks.length"
        image="search"
        :description="scope === 'mine' ? '暂无与您相关的任务（负责人或参与人含您）' : '任务表暂无任务'"
      />

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

        <!-- 重点展示：逾期 / 临期（渐变底 + 悬浮任务行 + 剩余天数徽章） -->
        <section v-if="overdueList.length" class="focus overdue" aria-label="已逾期任务">
          <header class="focus-hd">
            <span class="focus-ico"><van-icon name="warning-o" /></span>
            <span class="focus-title">已逾期</span>
            <span class="focus-count">{{ overdueList.length }} 项</span>
          </header>
          <ul class="focus-list">
            <li
              v-for="(t, i) in overdueList"
              :key="t.recordId"
              class="focus-item"
              :style="{ animationDelay: `${Math.min(i, 6) * 45}ms` }"
            >
              <div class="fi-main">
                <p class="fi-name">{{ t.title }}</p>
                <p class="fi-meta">
                  <span><van-icon name="manager-o" />{{ t.owner || '未指派' }}</span>
                  <span class="fi-date"><van-icon name="calendar-o" />{{ shortDate(t.planDate) }}</span>
                </p>
              </div>
              <span class="fi-chip">{{ dueText(t.planDate) }}</span>
            </li>
          </ul>
        </section>

        <section v-if="dueSoonList.length" class="focus soon" aria-label="即将到期任务">
          <header class="focus-hd">
            <span class="focus-ico"><van-icon name="underway-o" /></span>
            <span class="focus-title">{{ DUE_SOON_DAYS }}天内到期</span>
            <span class="focus-count">{{ dueSoonList.length }} 项</span>
          </header>
          <ul class="focus-list">
            <li
              v-for="(t, i) in dueSoonList"
              :key="t.recordId"
              class="focus-item"
              :style="{ animationDelay: `${Math.min(i, 6) * 45}ms` }"
            >
              <div class="fi-main">
                <p class="fi-name">{{ t.title }}</p>
                <p class="fi-meta">
                  <span><van-icon name="manager-o" />{{ t.owner || '未指派' }}</span>
                  <span class="fi-date"><van-icon name="calendar-o" />{{ shortDate(t.planDate) }}</span>
                </p>
              </div>
              <span class="fi-chip" :class="{ hot: dayDiff(t.planDate) === 0 }">{{ dueText(t.planDate) }}</span>
            </li>
          </ul>
        </section>

        <!-- 无逾期无临期：正向反馈条 -->
        <div v-if="!overdueList.length && !dueSoonList.length" class="focus-ok">
          <van-icon name="checked" />
          暂无逾期与临期任务，一切按计划推进
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

/* 团队/我的 滑动门切换：胶囊轨道 + 白色滑块 */
.scope-switch {
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
}
.scope-track {
  position: relative;
  display: flex;
  width: 172px;
  padding: 3px;
  border-radius: 999px;
  background: #eceef2;
}
.scope-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 3px);
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  transition: transform 0.25s cubic-bezier(0.22, 0.85, 0.32, 1);
}
.scope-thumb.right {
  transform: translateX(100%);
}
.scope-track button {
  position: relative;
  z-index: 1;
  flex: 1;
  border: none;
  background: none;
  padding: 5px 0;
  font-size: 13px;
  font-weight: 600;
  color: #969799;
  transition: color 0.2s;
}
.scope-track button.active {
  color: #323233;
}

/* 统计卡片：三等分自适应（grid），数字大标签小，颜色区分状态 */
.stats-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.stat-card {
  background: #fff;
  border-radius: 14px;
  padding: 12px 4px 10px;
  text-align: center;
  min-width: 0; /* 允许窄屏压缩 */
  border: 1px solid rgba(0, 0, 0, 0.035);
}
.stat-num {
  font-size: 26px;
  font-weight: 750;
  line-height: 1.15;
  color: #323233;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}
.stat-label {
  margin-top: 3px;
  font-size: 11px;
  color: #969799;
  white-space: nowrap;
}
.stat-soon {
  background: linear-gradient(160deg, rgba(255, 151, 106, 0.13), rgba(255, 151, 106, 0.03) 70%);
  border-color: rgba(255, 151, 106, 0.16);
}
.stat-soon .stat-num {
  color: #ef7a3c;
}
.stat-overdue {
  background: linear-gradient(160deg, rgba(238, 10, 36, 0.09), rgba(238, 10, 36, 0.02) 70%);
  border-color: rgba(238, 10, 36, 0.12);
}
.stat-overdue .stat-num {
  color: #ee0a24;
}

/* ===== 重点展示区：渐变底容器 + 悬浮任务行 ===== */
.focus {
  position: relative;
  border-radius: 16px;
  padding: 12px 10px 4px;
  margin-bottom: 12px;
  overflow: hidden;
}
.focus.overdue {
  background: linear-gradient(165deg, rgba(238, 10, 36, 0.07), rgba(238, 10, 36, 0.015) 60%);
  border: 1px solid rgba(238, 10, 36, 0.1);
}
.focus.soon {
  background: linear-gradient(165deg, rgba(255, 151, 106, 0.11), rgba(255, 151, 106, 0.02) 60%);
  border: 1px solid rgba(255, 151, 106, 0.16);
}

.focus-hd {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 4px 10px;
}
.focus-ico {
  width: 22px;
  height: 22px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.overdue .focus-ico {
  background: rgba(238, 10, 36, 0.12);
  color: #ee0a24;
}
.soon .focus-ico {
  background: rgba(255, 151, 106, 0.16);
  color: #ef7a3c;
}
.focus-title {
  font-size: 13.5px;
  font-weight: 650;
  letter-spacing: 0.2px;
}
.overdue .focus-title {
  color: #c8202f;
}
.soon .focus-title {
  color: #c96a2f;
}
.focus-count {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.75);
}
.overdue .focus-count {
  color: #ee0a24;
  border: 1px solid rgba(238, 10, 36, 0.14);
}
.soon .focus-count {
  color: #ef7a3c;
  border: 1px solid rgba(255, 151, 106, 0.22);
}

.focus-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.focus-item {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(0, 0, 0, 0.035);
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 8px;
  animation: fi-rise 0.32s cubic-bezier(0.22, 0.85, 0.32, 1) backwards;
  transition: transform 0.15s ease;
}
.focus-item:active {
  transform: scale(0.98);
}
.overdue .focus-item {
  box-shadow: 0 1px 3px rgba(238, 10, 36, 0.05);
}
.soon .focus-item {
  box-shadow: 0 1px 3px rgba(255, 151, 106, 0.07);
}

.fi-main {
  flex: 1;
  min-width: 0;
}
.fi-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  color: #323233;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.fi-meta {
  margin-top: 3px;
  display: flex;
  gap: 12px;
  font-size: 11.5px;
  color: #969799;
  min-width: 0;
}
.fi-meta .van-icon {
  font-size: 11px;
  vertical-align: -1.5px;
  margin-right: 2px;
}
.fi-meta > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 剩余天数徽章：逾期/临期软色底，今日到期实心渐变强提醒 */
.fi-chip {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  padding: 4px 10px;
  border-radius: 999px;
  white-space: nowrap;
}
.overdue .fi-chip {
  color: #ee0a24;
  background: rgba(238, 10, 36, 0.08);
  border: 1px solid rgba(238, 10, 36, 0.16);
}
.soon .fi-chip {
  color: #d96b32;
  background: rgba(255, 151, 106, 0.12);
  border: 1px solid rgba(255, 151, 106, 0.2);
}
.fi-chip.hot {
  color: #fff;
  background: linear-gradient(135deg, #ffb03a, #ff7038);
  border: none;
  box-shadow: 0 2px 6px rgba(255, 112, 56, 0.35);
}

@keyframes fi-rise {
  from {
    opacity: 0;
    transform: translateY(7px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .focus-item {
    animation: none;
  }
}

/* 无预警正向反馈条 */
.focus-ok {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 12px;
  color: #07c160;
  background: rgba(7, 193, 96, 0.06);
  border: 1px solid rgba(7, 193, 96, 0.12);
  border-radius: 12px;
  padding: 9px;
  margin-bottom: 12px;
}
.focus-ok .van-icon {
  font-size: 13px;
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
