<script setup>
import { computed, onActivated, onMounted, ref } from 'vue'
import { showFailToast } from 'vant'
import { getTaskLogs, getTasks } from '../api'
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
