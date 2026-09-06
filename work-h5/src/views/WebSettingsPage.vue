<script setup>
import { computed, onMounted, ref } from 'vue'
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant'
import {
  approveProjectApi,
  deleteProjectApi,
  getProjects,
  rejectProjectApi,
  runtime,
  saveProjectApi,
} from '../api'
import { initUser, userStore } from '../utils/user'
import { fixCurrentProject, projectStore, setCurrentProject } from '../utils/project'

/**
 * 桌面端设置页（从 /quick 顶栏进入）：项目切换 + 项目管理
 * - 项目切换：成员可点卡片切换；非成员置灰展示（数据访问由服务端 projectGuard 校验）
 * - 项目管理：所有用户可新建/编辑（普通用户新建进入待审核），管理员可审核/删除
 * - 点击项目名称复制 AI 表格地址；系统级深配置（AI模型/语音/标签库等）仍在移动端「设置」
 */
const isAdminUser = ref(false)
const pendingProjects = ref([])
const loaded = ref(false)

const curProjectId = computed(() => projectStore.projectId)
const curProjectName = computed(
  () => projectStore.projects.find((p) => p.id === projectStore.projectId)?.name || '',
)

async function load() {
  const pres = await getProjects().catch(() => null)
  if (!pres) return
  projectStore.projects = pres.projects || []
  pendingProjects.value = pres.pendingProjects || []
  isAdminUser.value = pres.isAdmin ?? userStore.isAdmin
  fixCurrentProject()
  loaded.value = true
}

/* ===================== 项目切换 ===================== */
function canSwitch(p) {
  return isAdminUser.value || p.member !== false
}

function switchProject(p) {
  if (!canSwitch(p)) return showToast('未加入该项目（以AI表格「项目成员表」为准）')
  if (p.id === curProjectId.value) return
  setCurrentProject(p.id)
  showSuccessToast(`已切换到「${p.name}」`)
}

/* ===================== 新建/编辑表单 ===================== */
const showForm = ref(false)
const saving = ref(false)
const editingPending = ref(false) // 编辑待审核项目：允许暂无AI表格地址（审批时自动建）
const form = ref({ id: '', name: '', baseId: '', autoCreateTable: true })

function openCreate() {
  editingPending.value = false
  form.value = { id: '', name: '', baseId: '', autoCreateTable: true }
  showForm.value = true
}

function openEdit(p) {
  editingPending.value = p.status === 'pending'
  form.value = { id: p.id, name: p.name, baseId: p.baseId || '', autoCreateTable: false }
  showForm.value = true
}

async function saveForm() {
  const f = form.value
  if (saving.value) return
  if (!f.name.trim()) return showToast('请填写项目名称')
  const autoCreate = !f.id && f.autoCreateTable && !f.baseId.trim()
  if (!autoCreate && !f.baseId.trim() && !editingPending.value) return showToast('请填写AI表格链接或开启自动建表')
  saving.value = true
  try {
    const res = await saveProjectApi({
      id: f.id,
      name: f.name.trim(),
      baseId: f.baseId.trim(),
      autoCreateTable: f.autoCreateTable,
    })
    showSuccessToast(res?.message || (f.id ? '项目已更新' : '项目已创建'))
    showForm.value = false
    await load()
  } catch (err) {
    showFailToast(err?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

/* ===================== 审核（管理员） ===================== */
const approvingId = ref('')
const rejectingId = ref('')
const deletingId = ref('')

async function doApprove(p) {
  if (approvingId.value) return
  approvingId.value = p.id
  try {
    const res = await approveProjectApi(p.id)
    showSuccessToast(res?.message || '已通过审核')
    await load()
  } catch (err) {
    showFailToast(err?.message || '审核失败')
  } finally {
    approvingId.value = ''
  }
}

async function doReject(p) {
  try {
    await showConfirmDialog({ title: '拒绝项目', message: `确定拒绝「${p.name}」？项目配置将被移除。` })
  } catch {
    return
  }
  rejectingId.value = p.id
  try {
    const res = await rejectProjectApi(p.id)
    showSuccessToast(res?.message || '已拒绝')
    await load()
  } catch (err) {
    showFailToast(err?.message || '操作失败')
  } finally {
    rejectingId.value = ''
  }
}

async function doDelete(p) {
  try {
    await showConfirmDialog({ title: '删除项目', message: `确定删除「${p.name}」？仅移除系统配置，AI表格数据不受影响。` })
  } catch {
    return
  }
  deletingId.value = p.id
  try {
    await deleteProjectApi(p.id)
    showSuccessToast('项目已删除')
    if (curProjectId.value === p.id) setCurrentProject('')
    await load()
  } catch (err) {
    showFailToast(err?.message || '删除失败')
  } finally {
    deletingId.value = ''
  }
}

/* ===================== 点击名称复制 AI 表格地址 ===================== */
async function copyTableUrl(p) {
  if (!p.baseId) return showFailToast('该项目暂无AI表格地址（待审核自动建表）')
  const url = `https://alidocs.dingtalk.com/i/nodes/${p.baseId}`
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
    } else {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    showSuccessToast('AI表格地址已复制')
  } catch {
    showFailToast('复制失败，请稍后重试')
  }
}

onMounted(async () => {
  await initUser()
  await load()
})
</script>

<template>
  <div class="web-settings">
    <!-- 顶栏（毛玻璃，与快速填写页一致） -->
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">设</span>
          <span class="brand-text">系统设置</span>
        </div>
        <nav class="top-nav" aria-label="页面导航">
          <router-link to="/quick" class="nav-link">快速填写</router-link>
        </nav>
        <div class="top-right">
          <span v-if="curProjectName" class="proj-chip" title="当前项目">
            <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
              <path
                d="M1.5 3.7A1.7 1.7 0 0 1 3.2 2h2.6l1.5 2h3.5A1.7 1.7 0 0 1 12.5 5.7v5.1A1.7 1.7 0 0 1 10.8 12.5H3.2a1.7 1.7 0 0 1-1.7-1.7V3.7z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
            </svg>
            {{ curProjectName }}
          </span>
          <span class="user-chip">
            {{ userStore.name || '加载中' }}
            <em v-if="isAdminUser" class="admin-tag">管理员</em>
            <em v-if="runtime.mockMode" class="mock-tag">演示</em>
          </span>
        </div>
      </div>
    </header>

    <main class="layout">
      <!-- 项目切换 -->
      <section class="panel panel-1">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">项目切换</h2>
            <p class="panel-sub">点击切换当前工作项目；未加入的项目仅展示，成员以AI表格「项目成员表」为准</p>
          </div>
        </div>
        <div v-if="projectStore.projects.length" class="proj-grid">
          <button
            v-for="p in projectStore.projects"
            :key="p.id"
            type="button"
            class="proj-card"
            :class="{ active: p.id === curProjectId, disabled: !canSwitch(p) }"
            @click="switchProject(p)"
          >
            <span class="pc-name">{{ p.name }}</span>
            <span v-if="p.id === curProjectId" class="pc-tag pc-tag-current">当前</span>
            <span v-else-if="!canSwitch(p)" class="pc-tag pc-tag-none">未加入</span>
          </button>
        </div>
        <div v-else-if="loaded" class="empty-state">
          <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
            <path
              d="M4 11a3 3 0 0 1 3-3h8l3 4h15a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V11z"
              fill="none"
              stroke="#c9cfd8"
              stroke-width="2"
              stroke-linejoin="round"
            />
            <path d="M4 17h32" stroke="#dfe4ea" stroke-width="2" stroke-linecap="round" />
          </svg>
          <p class="es-title">还没有可用项目</p>
          <p class="es-sub">在下方「项目管理」新建，审核通过后即可使用</p>
        </div>
        <p v-else class="empty-tip">项目加载中…</p>
      </section>

      <!-- 项目管理 -->
      <section class="panel panel-2">
        <div class="panel-head pm-head">
          <div>
            <h2 class="panel-title">
              项目管理
              <span class="pm-count">
                共 {{ projectStore.projects.length }} 个<template v-if="pendingProjects.length"> · 待审核 {{ pendingProjects.length }} 个</template>
              </span>
            </h2>
            <p class="panel-sub">点击项目名称可复制AI表格地址</p>
          </div>
          <button type="button" class="q-btn q-btn-primary q-btn-sm pm-create" @click="openCreate">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M6 2v8M2 6h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            新建项目
          </button>
        </div>

        <!-- 新建/编辑表单 -->
        <div v-if="showForm" class="pm-form">
          <div class="form-row">
            <label class="f-label">项目名称</label>
            <div class="f-control">
              <input v-model="form.name" class="q-input" maxlength="30" placeholder="例如：XX客户交付项目" />
            </div>
          </div>
          <div class="form-row">
            <label class="f-label">AI表格链接</label>
            <div class="f-control">
              <input
                v-model="form.baseId"
                class="q-input"
                :disabled="!form.id && form.autoCreateTable"
                placeholder="粘贴钉钉AI表格地址，或开启自动建表"
              />
              <p class="f-hint">
                <template v-if="!form.id && form.autoCreateTable">
                  {{ isAdminUser ? '已开启自动建表，无需粘贴链接' : '已开启自动建表，审核通过时自动创建，无需粘贴链接' }}
                </template>
                <template v-else-if="editingPending">待审核项目走自动建表时暂无地址，审核通过后自动生成</template>
                <template v-else>支持直接粘贴文档地址，自动提取 Base ID</template>
              </p>
            </div>
          </div>
          <div v-if="!form.id" class="form-row">
            <label class="f-label">自动建表</label>
            <div class="f-control">
              <label class="q-check">
                <input v-model="form.autoCreateTable" type="checkbox" />
                <span>{{ isAdminUser ? '保存时自动创建AI表格及四张标准数据表' : '审核通过时自动创建AI表格及四张标准数据表' }}</span>
              </label>
            </div>
          </div>
          <div class="pm-form-actions">
            <button type="button" class="q-btn q-btn-ghost q-btn-sm" @click="showForm = false">取消</button>
            <button type="button" class="q-btn q-btn-primary q-btn-sm" :disabled="saving" @click="saveForm">
              {{ saving ? '保存中…' : form.id ? '保存修改' : !isAdminUser ? '提交审核' : '保存项目' }}
            </button>
          </div>
        </div>

        <!-- 待审核列表 -->
        <div v-if="pendingProjects.length" class="list-group-title">
          待审核
          <span class="lg-count">{{ pendingProjects.length }}</span>
        </div>
        <div v-for="p in pendingProjects" :key="p.id" class="pm-row pending">
          <span class="pm-name" title="点击复制AI表格地址" @click="copyTableUrl(p)">{{ p.name }}</span>
          <span class="pm-tag pm-tag-pending">待审核</span>
          <span class="pm-sub">提交人：{{ p.createdBy?.name || '—' }}</span>
          <span class="pm-actions">
            <a
              v-if="p.baseId"
              class="pm-table-link"
              :href="`https://alidocs.dingtalk.com/i/nodes/${p.baseId}`"
              target="_blank"
              rel="noopener"
              title="在新窗口打开AI表格"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path
                  d="M5 2h5v5M10 2L4.5 7.5M8.5 6.5V10h-7V3h3.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </a>
            <button type="button" class="q-btn q-btn-ghost q-btn-sm" @click="openEdit(p)">编辑</button>
            <template v-if="isAdminUser">
              <button
                type="button"
                class="q-btn q-btn-primary q-btn-sm"
                :disabled="approvingId === p.id"
                @click="doApprove(p)"
              >
                {{ approvingId === p.id ? '审批中…' : '同意' }}
              </button>
              <button
                type="button"
                class="q-btn q-btn-danger q-btn-sm"
                :disabled="rejectingId === p.id"
                @click="doReject(p)"
              >
                拒绝
              </button>
            </template>
            <span v-else class="pm-wait-tip">等待管理员审核，通过后即可使用</span>
          </span>
        </div>

        <!-- 已审核列表 -->
        <div v-if="projectStore.projects.length" class="list-group-title">
          已生效
          <span class="lg-count">{{ projectStore.projects.length }}</span>
        </div>
        <div v-for="p in projectStore.projects" :key="p.id" class="pm-row">
          <span class="pm-name" title="点击复制AI表格地址" @click="copyTableUrl(p)">{{ p.name }}</span>
          <span v-if="p.id === curProjectId" class="pm-tag pm-tag-current">当前</span>
          <span class="pm-sub">日志表：{{ p.sheetId || '工作日志表' }} · 任务表：{{ p.taskSheetName || '任务表' }}</span>
          <span class="pm-actions">
            <a
              class="pm-table-link"
              :href="`https://alidocs.dingtalk.com/i/nodes/${p.baseId}`"
              target="_blank"
              rel="noopener"
              title="在新窗口打开AI表格"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path
                  d="M5 2h5v5M10 2L4.5 7.5M8.5 6.5V10h-7V3h3.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </a>
            <button type="button" class="q-btn q-btn-ghost q-btn-sm" @click="openEdit(p)">编辑</button>
            <button
              v-if="isAdminUser"
              type="button"
              class="q-btn q-btn-danger q-btn-sm"
              :disabled="deletingId === p.id"
              @click="doDelete(p)"
            >
              删除
            </button>
          </span>
        </div>

        <p class="f-hint pm-foot-tip">
          {{ isAdminUser ? '新建即生效' : '新建后需管理员审核' }}；系统级配置（AI模型、语音识别等）请在钉钉内「设置」维护
        </p>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* 本文件被 vite 的 px→vw 适配排除，样式保持 px */
.web-settings {
  min-height: 100dvh;
  background: #f6f7fa;
  font-size: 14px;
  color: var(--text-main, #232b38);
  font-variant-numeric: tabular-nums;
  position: relative;
}

/* 背景氛围：纯 CSS 双 radial 光晕（与快速填写页一致） */
.web-settings::before {
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

/* 当前项目胶囊（与快速填写页一致） */
.proj-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  font-size: 12px;
  font-weight: 500;
  color: #0e5fd8;
  background: rgba(22, 119, 255, 0.08);
  border: 1px solid rgba(22, 119, 255, 0.16);
  border-radius: 999px;
  max-width: 200px;
}

.proj-chip svg {
  flex-shrink: 0;
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

.admin-tag {
  font-style: normal;
  font-size: 11px;
  color: #0e5fd8;
  font-weight: 600;
}

.mock-tag {
  font-style: normal;
  font-size: 11px;
  color: #d97706;
}

/* ============ 布局 ============ */
.layout {
  position: relative;
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px 24px 44px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 入场：面板依次上浮 */
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

.panel-1 {
  animation: panel-rise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.panel-2 {
  animation: panel-rise 0.45s 0.08s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@media (prefers-reduced-motion: reduce) {
  .panel-1,
  .panel-2,
  .pm-form {
    animation: none;
  }
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
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid #eef0f4;
  margin-bottom: 10px;
}

.panel-title {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.pm-count {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: #98a2b3;
}

.panel-sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: #8a94a3;
}

.pm-create {
  height: 32px;
  padding: 0 14px;
  font-size: 13px;
  flex-shrink: 0;
}

/* ============ 项目切换卡片 ============ */
.proj-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.proj-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 13px 16px;
  border: 1px solid #e7ebf1;
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.2, 0.8, 0.3, 1);
  font-family: inherit;
}

.proj-card:hover:not(.disabled) {
  border-color: rgba(22, 119, 255, 0.55);
  transform: translateY(-1px);
  box-shadow: 0 6px 16px -8px rgba(23, 43, 77, 0.22);
}

.proj-card:active:not(.disabled) {
  transform: scale(0.985);
}

.proj-card.active {
  border-color: #1677ff;
  background: rgba(22, 119, 255, 0.05);
  box-shadow: 0 0 0 3px rgba(22, 119, 255, 0.12);
}

.proj-card.disabled {
  cursor: not-allowed;
  opacity: 0.62;
  background: #fafbfc;
}

.pc-name {
  font-size: 14px;
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pc-tag {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  font-weight: 600;
}

.pc-tag-current {
  color: #0e5fd8;
  background: rgba(22, 119, 255, 0.1);
}

.pc-tag-none {
  color: #98a2b3;
  background: #eef1f5;
  font-weight: 500;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 30px 0 22px;
}

.es-title {
  margin: 10px 0 0;
  font-size: 13.5px;
  font-weight: 600;
  color: #667085;
}

.es-sub {
  margin: 0;
  font-size: 12px;
  color: #98a2b3;
}

.empty-tip {
  margin: 8px 0 4px;
  font-size: 13px;
  color: #98a2b3;
  text-align: center;
}

/* ============ 新建/编辑表单 ============ */
.pm-form {
  background: #f8fafd;
  border: 1px solid #e3eaf5;
  border-radius: 12px;
  padding: 16px 20px 14px;
  margin-bottom: 12px;
  animation: panel-rise 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.form-row {
  display: flex;
  gap: 14px;
  padding: 8px 0;
}

.f-label {
  width: 84px;
  flex-shrink: 0;
  text-align: right;
  font-size: 13.5px;
  font-weight: 550;
  color: #475467;
  line-height: 40px;
}

.f-control {
  flex: 1;
  min-width: 0;
}

.q-input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 1px solid #dde2ea;
  border-radius: 10px;
  background: #fff;
  font-size: 14px;
  font-family: inherit;
  color: var(--text-main, #232b38);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.q-input:hover {
  border-color: #b9c2d0;
}

.q-input:focus {
  outline: none;
  border-color: #1677ff;
  box-shadow: 0 0 0 3px rgba(22, 119, 255, 0.14);
}

.q-input:disabled {
  background: #f2f3f5;
  color: #98a2b3;
  cursor: not-allowed;
}

.f-hint {
  margin: 7px 0 0;
  font-size: 12px;
  color: #98a2b3;
}

.q-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  font-size: 14px;
  color: #475467;
  cursor: pointer;
}

.q-check input {
  width: 16px;
  height: 16px;
  accent-color: #1677ff;
  cursor: pointer;
}

.pm-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 8px;
}

/* ============ 按钮 ============ */
.q-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
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

.q-btn-danger {
  border: 1px solid rgba(217, 45, 32, 0.28);
  background: #fff;
  color: #d92d20;
}

.q-btn-danger:not(:disabled):hover {
  background: #fef3f2;
  border-color: rgba(217, 45, 32, 0.5);
}

.q-btn-sm {
  height: 30px;
  padding: 0 13px;
  font-size: 12.5px;
  border-radius: 8px;
}

/* ============ 项目列表 ============ */
.list-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #98a2b3;
  font-weight: 600;
  letter-spacing: 0.02em;
  margin: 14px 0 4px;
}

.lg-count {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: #eef1f5;
  color: #667085;
  font-size: 11px;
}

.pm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  margin: 0 -10px;
  border-radius: 10px;
  transition: background-color 0.15s ease;
}

.pm-row:hover {
  background: #f6f8fb;
}

.pm-row.pending {
  background: rgba(217, 119, 6, 0.05);
}

.pm-row.pending:hover {
  background: rgba(217, 119, 6, 0.09);
}

.pm-name {
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border-bottom: 1px dashed #c8cdd6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
  transition: color 0.15s ease;
}

.pm-name:hover {
  color: #1677ff;
  border-bottom-color: #1677ff;
}

.pm-tag {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  font-weight: 600;
}

.pm-tag-pending {
  color: #b45309;
  background: rgba(217, 119, 6, 0.12);
}

.pm-tag-current {
  color: #0e5fd8;
  background: rgba(22, 119, 255, 0.1);
}

.pm-sub {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #98a2b3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.pm-table-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid #e3e8ef;
  border-radius: 8px;
  background: #fff;
  color: #475467;
  transition: all 0.16s ease;
}

.pm-table-link:hover {
  border-color: #1677ff;
  color: #1677ff;
  background: rgba(22, 119, 255, 0.04);
}

.pm-table-link:active {
  transform: scale(0.94);
}

.pm-wait-tip {
  font-size: 12px;
  color: #98a2b3;
}

.pm-foot-tip {
  margin: 16px 0 0;
  text-align: center;
}

/* 键盘可达性：统一焦点环 */
:where(button, a):focus-visible {
  outline: 2px solid rgba(22, 119, 255, 0.55);
  outline-offset: 2px;
  border-radius: 8px;
}

/* ============ 窄屏兜底 ============ */
@media (max-width: 720px) {
  .topbar-inner {
    gap: 12px;
    padding: 0 14px;
  }

  .brand-text {
    display: none;
  }

  .form-row {
    flex-direction: column;
    gap: 4px;
  }

  .f-label {
    width: auto;
    text-align: left;
    line-height: 28px;
  }

  .pm-name {
    max-width: 150px;
  }

  .pm-sub {
    display: none;
  }
}
</style>
