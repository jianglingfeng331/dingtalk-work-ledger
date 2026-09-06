<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { enrichWork, getTasks, getWorkList, runtime, submitWork } from '../api'
import { fmtDate } from '../utils/format'
import { initUser, userStore } from '../utils/user'
import { loadMyProjects, projectStore } from '../utils/project'

/**
 * web端（电脑）快速填写工作台账：桌面布局
 * - 顶栏导航 + 双栏：左侧表单（原生下拉/输入控件），右侧今日已填
 * - 无语音、无移动端弹层：任务/完成情况/工时直接选好，一键提交（Ctrl+Enter）
 * - 保留智能润色（口语内容 → 通顺书面描述）
 */
const content = ref('')
const hoursInput = ref('')
const submitting = ref(false)
const enriching = ref(false)
const progress = ref('未开始')
const todayRecords = ref([])
const HOUR_PRESETS = [0.5, 1, 2, 4, 8]

const STATUSES = ['未开始', '进行中', '已完成']
const PROGRESS_META = {
  已完成: { color: '#0aa56d' },
  进行中: { color: '#1677ff' },
  未开始: { color: '#98a2b3' },
}

const today = fmtDate()
const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()]

/** 当前项目（日志随请求头 x-project-id 推送到所选项目） */
const curProject = computed(() => projectStore.projects.find((p) => p.id === projectStore.projectId))
const curProjectName = computed(() => curProject.value?.name || '')
const curProjectBaseId = computed(() => curProject.value?.baseId || '')

/* ===================== 任务选择（不选则提交时智能匹配） ===================== */
const myTasks = ref([]) // 与当前用户相关的未完成任务（负责人或参与人含本人）
const selectedTaskId = ref('')

async function loadMyTasks() {
  try {
    const res = await getTasks({ mine: 1 })
    myTasks.value = res?.enabled === false ? [] : (res?.tasks || []).filter((t) => t.status !== '已完成')
    if (selectedTaskId.value && !myTasks.value.some((t) => t.recordId === selectedTaskId.value)) {
      selectedTaskId.value = ''
    }
  } catch {
    myTasks.value = []
  }
}

/* ===================== 今日已填（提交结果回显） ===================== */
async function loadToday() {
  try {
    todayRecords.value = (await getWorkList({ scope: 'today' })) || []
  } catch {
    todayRecords.value = []
  }
}

/* ===================== 智能润色（可选） ===================== */
async function enrich() {
  const text = content.value.trim()
  if (!text) return showToast('请先填写工作内容')
  if (enriching.value) return
  enriching.value = true
  try {
    const res = await enrichWork(text)
    content.value = res.content
    showToast(res.source === 'ai' ? 'AI 已润色' : '已整理（AI未启用，规则整理）')
  } catch (err) {
    showFailToast(err?.message || '润色失败，请重试')
  } finally {
    enriching.value = false
  }
}

/* ===================== 提交 ===================== */
async function submit() {
  const text = content.value.trim()
  if (!text) return showToast('请填写工作内容')
  if (submitting.value) return

  let hours = null
  const raw = String(hoursInput.value ?? '').trim()
  if (raw) {
    hours = Number(raw)
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) return showToast('工时请填写 0~24 之间的数值')
    hours = Math.round(hours * 2) / 2 // 归整到 0.5 步进
  }

  submitting.value = true
  try {
    const res = await submitWork(text, { progress: progress.value, hours }, selectedTaskId.value)
    showSuccessToast(res?.__message || (runtime.mockMode ? '已记录（本地演示）' : '已同步钉钉AI表格'))
    content.value = ''
    hoursInput.value = ''
    await loadToday()
  } catch (err) {
    showFailToast(err?.message || '提交失败，请重试')
  } finally {
    submitting.value = false
  }
}

// 切换项目后：任务清单与今日记录随之更换
watch(
  () => projectStore.projectId,
  () => {
    selectedTaskId.value = ''
    loadMyTasks()
    loadToday()
  },
)

onMounted(async () => {
  await initUser()
  await loadMyProjects() // 项目就绪后再查询，避免首启空项目查0条
  loadMyTasks()
  await loadToday()
})
</script>

<template>
  <div class="quick-page">
    <!-- 顶栏：品牌 + 导航 + 项目/用户 -->
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">快</span>
          <span class="brand-text">工作台账</span>
        </div>
        <nav class="top-nav" aria-label="页面导航">
          <router-link to="/settings-web" class="nav-link">设置</router-link>
        </nav>
        <div class="top-right">
          <span v-if="curProjectName" class="proj-chip">{{ curProjectName }}</span>
          <a
            v-if="curProjectBaseId"
            class="table-link"
            :href="`https://alidocs.dingtalk.com/i/nodes/${curProjectBaseId}`"
            target="_blank"
            rel="noopener"
            title="在新窗口打开当前项目的AI表格"
          >
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
              <path
                d="M5 2h5v5M10 2L4.5 7.5M8.5 6.5V10h-7V3h3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            AI表格
          </a>
          <span class="user-chip">
            {{ userStore.name || '加载中' }}
            <em v-if="runtime.mockMode" class="mock-tag">演示</em>
          </span>
        </div>
      </div>
    </header>

    <main class="layout">
      <!-- 左：填写表单 -->
      <section class="panel form-panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">填写今日工作</h2>
            <p class="panel-sub">
              <span class="date-chip">{{ today }}</span>
              <span>周{{ weekday }}</span>
              <span class="dot-sep">·</span>
              <span>选任务、填内容，一键提交</span>
            </p>
          </div>
          <div v-if="curProjectName" class="cur-project" title="当前项目">
            <span class="cp-icon" aria-hidden="true">
              <svg viewBox="0 0 14 14" width="14" height="14">
                <path
                  d="M1.5 3.7A1.7 1.7 0 0 1 3.2 2h2.6l1.5 2h3.5A1.7 1.7 0 0 1 12.5 5.7v5.1A1.7 1.7 0 0 1 10.8 12.5H3.2a1.7 1.7 0 0 1-1.7-1.7V3.7z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <span class="cp-text">
              <span class="cp-label">当前项目</span>
              <span class="cp-name">{{ curProjectName }}</span>
            </span>
          </div>
        </div>

        <div class="form-body">
          <div class="form-row">
            <label class="f-label" for="qf-task">关联任务</label>
            <div class="f-control">
              <div class="select-wrap">
                <select id="qf-task" v-model="selectedTaskId" class="q-select">
                  <option value="">不指定（提交时按内容智能匹配）</option>
                  <option v-for="t in myTasks" :key="t.recordId" :value="t.recordId">{{ t.title }}</option>
                </select>
                <svg class="select-caret" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </div>
              <p v-if="!myTasks.length" class="f-hint">暂无可关联的未完成任务，可不选直接提交</p>
            </div>
          </div>

          <div class="form-row">
            <label class="f-label">完成情况</label>
            <div class="f-control">
              <div class="seg-group" role="radiogroup" aria-label="完成情况">
                <button
                  v-for="s in STATUSES"
                  :key="s"
                  type="button"
                  role="radio"
                  :aria-checked="progress === s"
                  class="seg-item"
                  :class="{ active: progress === s }"
                  @click="progress = s"
                >
                  <i class="seg-dot" :style="{ background: progress === s ? PROGRESS_META[s].color : '#b6bdc9' }" />
                  {{ s }}
                </button>
              </div>
            </div>
          </div>

          <div class="form-row">
            <label class="f-label" for="qf-hours">工时</label>
            <div class="f-control">
              <div class="hours-line">
                <input
                  id="qf-hours"
                  v-model="hoursInput"
                  type="number"
                  class="q-input hours-input"
                  min="0"
                  max="24"
                  step="0.5"
                  placeholder="可不填"
                />
                <span class="hours-unit">小时</span>
                <span class="hours-presets" aria-label="常用工时">
                  <button
                    v-for="h in HOUR_PRESETS"
                    :key="h"
                    type="button"
                    class="preset-chip"
                    :class="{ on: Number(hoursInput) === h }"
                    @click="hoursInput = Number(hoursInput) === h ? '' : String(h)"
                  >
                    {{ h }}h
                  </button>
                </span>
              </div>
            </div>
          </div>

          <div class="form-row form-row-top">
            <label class="f-label f-label-top" for="qf-content">工作内容</label>
            <div class="f-control">
              <textarea
                id="qf-content"
                v-model="content"
                class="q-textarea"
                rows="6"
                maxlength="500"
                placeholder="填写今天的工作内容，例如：完成登录模块开发并自测通过，与小王联调了接口"
                @keydown.ctrl.enter.exact.prevent="submit"
              />
              <div class="textarea-foot">
                <span class="f-hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 快速提交</span>
                <span class="f-hint word-count">{{ content.length }}/500</span>
              </div>
            </div>
          </div>
        </div>

        <div class="form-actions">
          <button type="button" class="q-btn q-btn-ghost" :disabled="!content.trim() || enriching" @click="enrich">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 1l1.35 4.03L14 6.4l-3.4 2.9.98 4.32L8 11.5l-3.58 2.12.98-4.32L2 6.4l4.65-1.37L8 1z" fill="currentColor" />
            </svg>
            {{ enriching ? '润色中…' : '智能润色' }}
          </button>
          <button type="button" class="q-btn q-btn-primary" :disabled="!content.trim() || submitting" @click="submit">
            {{ submitting ? '提交中…' : '提交工作台账' }}
          </button>
        </div>
      </section>

      <!-- 右：今日已填 -->
      <aside class="panel today-panel">
        <div class="panel-head">
          <h2 class="panel-title panel-title-sm">今日已填</h2>
          <span class="today-count">{{ todayRecords.length }} 条</span>
        </div>
        <ul v-if="todayRecords.length" class="today-list">
          <li v-for="r in todayRecords" :key="r.id" class="today-item" :title="r.rawContent || r.title">
            <i class="seg-dot" :style="{ background: PROGRESS_META[r.progress]?.color || '#98a2b3' }" />
            <span class="t-title">{{ r.title }}</span>
            <span class="t-status" :style="{ color: PROGRESS_META[r.progress]?.color || '#98a2b3' }">{{ r.progress }}</span>
            <span v-if="r.hours != null" class="t-hours">{{ r.hours }}h</span>
          </li>
        </ul>
        <div v-else class="today-empty">
          <svg viewBox="0 0 40 40" width="36" height="36" aria-hidden="true">
            <rect x="7" y="4" width="26" height="32" rx="4" fill="none" stroke="#c9d2de" stroke-width="2" />
            <path d="M13 13h14M13 20h14M13 27h8" stroke="#c9d2de" stroke-width="2" stroke-linecap="round" />
          </svg>
          <p class="te-title">今日暂无记录</p>
          <p class="te-sub">提交工作内容后，会在这里实时回显</p>
        </div>
      </aside>
    </main>
  </div>
</template>

<style scoped>
/* 本文件被 vite 的 px→vw 适配排除，样式保持 px */
.quick-page {
  min-height: 100vh;
  min-height: 100dvh;
  background: #f6f7fa;
  font-size: 14px;
  color: var(--text-main, #232b38);
  font-variant-numeric: tabular-nums;
  position: relative;
}

/* 背景氛围：纯 CSS 双 radial 光晕，打破纯平底色 */
.quick-page::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(760px 380px at 88% -12%, rgba(22, 119, 255, 0.07), transparent 62%),
    radial-gradient(680px 340px at -8% 108%, rgba(10, 165, 109, 0.045), transparent 60%);
  pointer-events: none;
}

/* ============ 顶栏（毛玻璃） ============ */
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(255, 255, 255, 0.78);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  border-bottom: 1px solid rgba(23, 43, 77, 0.08);
}

.topbar-inner {
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 24px;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 28px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-shrink: 0;
}

.brand-mark {
  width: 27px;
  height: 27px;
  border-radius: 9px;
  background: #1677ff;
  box-shadow: inset 0 -5px 8px rgba(0, 45, 110, 0.18), 0 2px 6px rgba(22, 119, 255, 0.35);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-text {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.top-nav {
  display: flex;
  gap: 4px;
  flex: 1;
}

.nav-link {
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 14px;
  color: #667085;
  text-decoration: none;
  transition: color 0.18s ease, background-color 0.18s ease;
}

.nav-link:hover {
  color: #1677ff;
  background: rgba(22, 119, 255, 0.07);
}

.nav-link.router-link-active {
  color: #0e5fd8;
  font-weight: 600;
  background: rgba(22, 119, 255, 0.1);
}

.top-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.proj-chip {
  padding: 4px 11px;
  font-size: 12px;
  font-weight: 500;
  color: #0e5fd8;
  background: rgba(22, 119, 255, 0.08);
  border: 1px solid rgba(22, 119, 255, 0.16);
  border-radius: 999px;
}

.table-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  font-size: 12px;
  font-weight: 500;
  color: #0e5fd8;
  background: rgba(22, 119, 255, 0.08);
  border: 1px solid rgba(22, 119, 255, 0.16);
  border-radius: 999px;
  text-decoration: none;
  transition: all 0.16s ease;
}

.table-link:hover {
  color: #0a58c9;
  background: rgba(22, 119, 255, 0.14);
  border-color: rgba(22, 119, 255, 0.32);
}

.table-link:active {
  transform: scale(0.96);
}

.user-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 13px;
  border-radius: 999px;
  background: #eef1f5;
  font-size: 13px;
  font-weight: 500;
  color: #475467;
}

.mock-tag {
  font-style: normal;
  font-size: 11px;
  color: #d97706;
}

/* ============ 双栏布局 ============ */
.layout {
  position: relative;
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px 24px 40px;
  display: flex;
  align-items: flex-start;
  gap: 18px;
}

.form-panel {
  flex: 1;
  min-width: 0;
}

.today-panel {
  width: 360px;
  flex-shrink: 0;
}

/* 面板：无边框化，靠柔和有色阴影分层 */
.panel {
  background: rgba(255, 255, 255, 0.94);
  border-radius: 16px;
  padding: 22px 26px 24px;
  box-shadow:
    0 1px 2px rgba(23, 43, 77, 0.04),
    0 12px 32px -14px rgba(23, 43, 77, 0.12);
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid #eef0f4;
  margin-bottom: 6px;
}

.panel-title {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.panel-title-sm {
  font-size: 15px;
}

.panel-sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: #8a94a3;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 当前项目徽标：面板头右侧高亮展示 */
.cur-project {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px 8px 9px;
  background: rgba(22, 119, 255, 0.05);
  border: 1px solid rgba(22, 119, 255, 0.22);
  border-radius: 12px;
  flex-shrink: 0;
}

.cp-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: #1677ff;
  color: #fff;
  box-shadow: inset 0 -4px 8px rgba(0, 45, 110, 0.18), 0 2px 5px rgba(22, 119, 255, 0.3);
}

.cp-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cp-label {
  font-size: 11px;
  color: #8a94a3;
  line-height: 1;
}

.cp-name {
  max-width: 240px;
  font-size: 15px;
  font-weight: 650;
  color: #1d2939;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.date-chip {
  font-variant-numeric: tabular-nums;
  color: #475467;
  font-weight: 550;
}

.dot-sep {
  color: #c9cfd8;
}

.today-count {
  margin-left: auto;
  font-size: 12px;
  color: #8a94a3;
  font-variant-numeric: tabular-nums;
}

/* 入场：面板依次上浮，transform/opacity 走 GPU */
@keyframes panel-rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.form-panel {
  animation: panel-rise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.today-panel {
  animation: panel-rise 0.45s 0.08s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@media (prefers-reduced-motion: reduce) {
  .form-panel,
  .today-panel {
    animation: none;
  }
}

/* ============ 表单（label 左、控件右开的桌面表单） ============ */
.form-body {
  padding-top: 4px;
}

.form-row {
  display: flex;
  gap: 14px;
  padding: 13px 0;
}

.f-label {
  width: 76px;
  flex-shrink: 0;
  text-align: right;
  font-size: 13.5px;
  font-weight: 550;
  color: #475467;
  line-height: 40px;
}

.form-row-top .f-label {
  line-height: 30px;
}

.f-control {
  flex: 1;
  min-width: 0;
}

/* 原生控件统一外观 */
.q-select,
.q-input,
.q-textarea {
  width: 100%;
  border: 1px solid #dde2ea;
  border-radius: 10px;
  background: #fff;
  font-size: 14px;
  color: var(--text-main, #232b38);
  font-family: inherit;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.q-select,
.q-input {
  height: 40px;
  padding: 0 12px;
}

.q-textarea {
  padding: 11px 14px;
  min-height: 136px;
  line-height: 1.65;
  resize: vertical;
}

.q-select:hover,
.q-input:hover,
.q-textarea:hover {
  border-color: #b9c2d0;
}

.q-select:focus,
.q-input:focus,
.q-textarea:focus {
  outline: none;
  border-color: #1677ff;
  box-shadow: 0 0 0 3px rgba(22, 119, 255, 0.14);
}

.select-wrap {
  position: relative;
}

.q-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 36px;
  cursor: pointer;
}

.select-caret {
  position: absolute;
  right: 13px;
  top: 50%;
  transform: translateY(-50%);
  color: #98a2b3;
  pointer-events: none;
}

.f-hint {
  margin: 7px 0 0;
  font-size: 12px;
  color: #98a2b3;
}

.textarea-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 7px;
}

.word-count {
  font-variant-numeric: tabular-nums;
  margin: 0;
}

kbd {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid #d5dae2;
  border-bottom-width: 2px;
  border-radius: 5px;
  background: #fff;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #667085;
  line-height: 1.5;
}

/* 完成情况：胶囊分段单选 */
.seg-group {
  display: inline-flex;
  background: #eef1f5;
  border-radius: 11px;
  padding: 3px;
  gap: 2px;
}

.seg-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 22px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 13.5px;
  color: #667085;
  cursor: pointer;
  font-family: inherit;
  transition: background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
}

.seg-item:hover {
  color: #344054;
}

.seg-item.active {
  background: #fff;
  color: #1d2939;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(23, 43, 77, 0.1), 0 2px 6px rgba(23, 43, 77, 0.06);
}

.seg-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background-color 0.18s ease;
}

/* 工时行 */
.hours-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hours-input {
  width: 128px;
}

.hours-unit {
  font-size: 13px;
  color: #667085;
}

.hours-presets {
  display: inline-flex;
  gap: 6px;
  margin-left: 10px;
  padding-left: 12px;
  border-left: 1px solid #eef0f4;
}

.preset-chip {
  height: 26px;
  padding: 0 10px;
  border: 1px solid #e3e8ef;
  border-radius: 999px;
  background: #fff;
  font-size: 12px;
  color: #667085;
  cursor: pointer;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  transition: all 0.16s ease;
}

.preset-chip:hover {
  border-color: #1677ff;
  color: #1677ff;
}

.preset-chip.on {
  border-color: #1677ff;
  background: rgba(22, 119, 255, 0.08);
  color: #0e5fd8;
  font-weight: 600;
}

.preset-chip:active {
  transform: scale(0.94);
}

/* 操作区 */
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 16px;
  margin-top: 8px;
  border-top: 1px solid #eef0f4;
}

.q-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 40px;
  padding: 0 24px;
  border-radius: 10px;
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
  border: none;
  transition: all 0.18s cubic-bezier(0.2, 0.8, 0.3, 1);
}

.q-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.q-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.q-btn-ghost {
  border: 1px solid #e3e8ef;
  background: #fff;
  color: #475467;
}

.q-btn-ghost:not(:disabled):hover {
  border-color: #1677ff;
  color: #1677ff;
  background: rgba(22, 119, 255, 0.04);
}

.q-btn-primary {
  background: #1677ff;
  color: #fff;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(22, 119, 255, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.q-btn-primary:not(:disabled):hover {
  background: #2b82ff;
  transform: translateY(-1px);
  box-shadow: 0 6px 16px -4px rgba(22, 119, 255, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

/* ============ 今日已填 ============ */
.today-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}

.today-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 6px;
  margin: 0 -6px;
  border-radius: 8px;
  transition: background-color 0.15s ease;
}

.today-item:hover {
  background: #f6f8fb;
}

.t-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.t-status {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
}

.t-hours {
  flex-shrink: 0;
  font-size: 12px;
  color: #d97706;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.today-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 26px 0 18px;
}

.te-title {
  margin: 10px 0 0;
  font-size: 13.5px;
  font-weight: 600;
  color: #667085;
}

.te-sub {
  margin: 0;
  font-size: 12px;
  color: #98a2b3;
}

/* 键盘可达性：统一焦点环 */
:where(button, a):focus-visible {
  outline: 2px solid rgba(22, 119, 255, 0.55);
  outline-offset: 2px;
  border-radius: 8px;
}

/* ============ 窄屏兜底（侧栏下移、label 顶置） ============ */
@media (max-width: 960px) {
  .layout {
    flex-direction: column;
    padding: 20px 14px 32px;
  }

  .today-panel {
    width: 100%;
  }

  .topbar-inner {
    gap: 12px;
    padding: 0 14px;
  }

  .brand-text {
    display: none;
  }

  .hours-presets {
    margin-left: 0;
    padding-left: 0;
    border-left: none;
  }
}
</style>
