<script setup>
import { computed, onMounted, ref } from 'vue'
import { showConfirmDialog, showFailToast, showLoadingToast, showSuccessToast } from 'vant'
import { deleteProjectApi, getProjects, getSettings, saveProjectApi, testProject, updateSettings } from '../api'
import { initUser, userStore } from '../utils/user'
import { projectStore, setCurrentProject } from '../utils/project'

const loading = ref(true)
const saving = ref(false)
const isAdminUser = ref(false)

const runtimeState = ref({ dingtalk: false, table: false, ai: false })

// 提供商预设（来自后端）
const providers = ref([])

// 表单状态（管理员共性配置）
const tags = ref([])
const newTag = ref('')
const suggestionsText = ref('')
const adminsText = ref('')
const dedupSec = ref(60)
const aiEnabled = ref(false)
const aiProvider = ref('zhipu')
const aiModel = ref('glm-4-flash')
const apiKeyMasked = ref('')
const apiKeyInput = ref('')
const xfAppId = ref('')
const xfApiKeyMasked = ref('')
const xfApiSecretMasked = ref('')
const xfApiKeyInput = ref('')
const xfApiSecretInput = ref('')
const asrEnabled = ref(false)

// 最近一次登录失败的诊断信息（localStorage 记录）
const loginError = ref('')

/* ===================== 项目管理（管理员） ===================== */
const showProjectForm = ref(false)
const savingProject = ref(false)
const testingProject = ref(false)
const deletingId = ref('')
const form = ref({
  id: '',
  name: '',
  baseId: '',
  sheetId: '工作日志表',
  taskSheetName: '任务表',
  memberSheetName: '项目成员表',
  operatorUnionId: '',
})

const providerPreset = computed(
  () => providers.value.find((p) => p.key === aiProvider.value) || { models: [], defaultModel: '' },
)

async function load() {
  loading.value = true
  try {
    await initUser()
    // 项目列表：管理员=全部；普通成员=按项目成员表过滤
    const pres = await getProjects().catch(() => ({ projects: [] }))
    projectStore.projects = pres.projects || []
    if (!projectStore.projects.some((p) => p.id === projectStore.projectId)) {
      setCurrentProject(projectStore.projects[0]?.id || '')
    }
    isAdminUser.value = pres.isAdmin ?? userStore.isAdmin

    if (isAdminUser.value) {
      const res = await getSettings()
      runtimeState.value = res.runtime || {}
      providers.value = res.providers || []
      tags.value = res.settings.tags || []
      suggestionsText.value = (res.settings.suggestions || []).join('\n')
      adminsText.value = (res.settings.adminUserIds || []).join('、')
      dedupSec.value = res.settings.dedupWindowSec ?? 60
      aiEnabled.value = Boolean(res.settings.ai?.enabled)
      aiProvider.value = res.settings.ai?.provider || 'zhipu'
      aiModel.value = res.settings.ai?.model || 'glm-4-flash'
      apiKeyMasked.value = res.settings.ai?.apiKeyMasked || ''
      xfAppId.value = res.settings.asr?.appId || ''
      xfApiKeyMasked.value = res.settings.asr?.apiKeyMasked || ''
      xfApiSecretMasked.value = res.settings.asr?.apiSecretMasked || ''
      asrEnabled.value = Boolean(res.settings.asr?.enabled)
    }
    try {
      const d = JSON.parse(localStorage.getItem('last_login_error') || 'null')
      if (d?.msg) {
        loginError.value = `[${d.time}·${d.env}·corpId${d.corpId || '未知'}] ${d.msg}`
      }
    } catch {
      /* ignore */
    }
  } finally {
    loading.value = false
  }
}

/** 切换当前项目：所有页面数据按项目隔离，切换后整页刷新加载新项目数据 */
function switchProject(id) {
  if (!id || id === projectStore.projectId) return
  setCurrentProject(id)
  showSuccessToast('已切换项目，正在刷新...')
  setTimeout(() => location.reload(), 600)
}

function openCreate() {
  form.value = {
    id: '',
    name: '',
    baseId: '',
    sheetId: '工作日志表',
    taskSheetName: '任务表',
    memberSheetName: '项目成员表',
    operatorUnionId: '',
  }
  showProjectForm.value = true
}

function openEdit(p) {
  form.value = {
    id: p.id,
    name: p.name || '',
    baseId: p.baseId || '',
    sheetId: p.sheetId || '工作日志表',
    taskSheetName: p.taskSheetName || '任务表',
    memberSheetName: p.memberSheetName || '项目成员表',
    operatorUnionId: p.operatorUnionId || '',
  }
  showProjectForm.value = true
}

async function saveProjectForm() {
  if (savingProject.value) return
  const f = form.value
  if (!f.name.trim()) return showFailToast('请填写项目名称')
  if (!f.baseId.trim()) return showFailToast('请填写AI表格链接或Base ID')
  savingProject.value = true
  try {
    await saveProjectApi({ ...f, name: f.name.trim(), baseId: f.baseId.trim() })
    showSuccessToast(f.id ? '项目已更新' : '项目已创建')
    showProjectForm.value = false
    const pres = await getProjects()
    projectStore.projects = pres.projects || []
    if (!projectStore.projects.some((p) => p.id === projectStore.projectId)) {
      setCurrentProject(projectStore.projects[0]?.id || '')
    }
  } catch (err) {
    showFailToast(err?.message || '保存失败')
  } finally {
    savingProject.value = false
  }
}

/** 删除项目：仅移除本系统配置，钉钉AI表格数据不受影响 */
async function doDeleteProject(p) {
  try {
    await showConfirmDialog({
      title: '删除项目',
      message: `确定删除「${p.name}」？\n仅移除本系统的项目配置，AI表格数据不受影响。`,
    })
  } catch {
    return
  }
  deletingId.value = p.id
  try {
    await deleteProjectApi(p.id)
    showSuccessToast('项目已删除')
    if (projectStore.projectId === p.id) setCurrentProject('')
    const pres = await getProjects()
    projectStore.projects = pres.projects || []
    if (!projectStore.projects.some((x) => x.id === projectStore.projectId)) {
      setCurrentProject(projectStore.projects[0]?.id || '')
    }
  } catch (err) {
    showFailToast(err?.message || '删除失败')
  } finally {
    deletingId.value = ''
  }
}

/** 连接测试：先保存当前表单，再真实拉取该项目工作日志表 */
async function doTestProject() {
  if (testingProject.value) return
  const f = form.value
  if (!f.id) return showFailToast('请先保存项目再测试')
  testingProject.value = true
  showLoadingToast({ message: '测试连接中...', forbidClick: true, duration: 0 })
  try {
    const res = await testProject(f.id, f.baseId.trim(), f.sheetId.trim(), f.operatorUnionId.trim())
    if (res.ok) showSuccessToast(res.message)
    else showFailToast(res.message)
  } catch (err) {
    showFailToast(err?.message || '测试失败')
  } finally {
    testingProject.value = false
  }
}

function addTag() {
  const t = newTag.value.trim()
  if (!t) return
  if (tags.value.includes(t)) return showFailToast('标签已存在')
  if (tags.value.length >= 50) return showFailToast('标签最多50个')
  tags.value.push(t)
  newTag.value = ''
}

function removeTag(i) {
  tags.value.splice(i, 1)
}

/** 切换提供商：模型切换为该提供商默认 */
function onProviderChange() {
  aiModel.value = providerPreset.value.defaultModel || ''
}

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    await updateSettings({
      tags: tags.value,
      suggestions: suggestionsText.value.split('\n').map((s) => s.trim()).filter(Boolean),
      adminUserIds: adminsText.value.split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean),
      dedupWindowSec: Number(dedupSec.value) || 0,
      ai: {
        enabled: aiEnabled.value,
        provider: aiProvider.value,
        model: aiModel.value.trim(),
        apiKey: apiKeyInput.value.trim(), // 空表示保持不变
      },
      asr: {
        appId: xfAppId.value.trim(),
        apiKey: xfApiKeyInput.value.trim(), // 空表示保持不变
        apiSecret: xfApiSecretInput.value.trim(),
      },
    })
    showSuccessToast('已保存并生效')
    apiKeyInput.value = ''
    xfApiKeyInput.value = ''
    xfApiSecretInput.value = ''
    await load()
  } catch (err) {
    showFailToast(err?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div class="header-top">
        <div>
          <h1 class="page-title">系统设置</h1>
          <p class="page-subtitle">{{ isAdminUser ? '动态配置 · 保存即生效' : '项目切换 · 日志计划按项目推送' }}</p>
        </div>
        <div class="user-chip">
          <van-icon name="manager-o" />
          <span class="name">{{ userStore.name }}</span>
        </div>
      </div>
    </header>

    <van-loading v-if="loading" class="page-loading" vertical>加载中...</van-loading>

    <template v-else>
      <!-- 当前项目（所有用户：切换后日志/计划推到对应项目） -->
      <section class="card section">
        <h3 class="section-title">当前项目 <span class="tip">切换后，提交的日志与计划推送到所选项目</span></h3>
        <van-empty
          v-if="!projectStore.projects.length"
          image="search"
          description="暂无可访问的项目，请联系管理员在项目管理中添加"
        />
        <van-radio-group v-else :model-value="projectStore.projectId" @update:model-value="switchProject">
          <div class="project-row" v-for="p in projectStore.projects" :key="p.id">
            <van-radio :name="p.id">
              <span class="project-name">{{ p.name }}</span>
            </van-radio>
            <span class="project-id">{{ (p.baseId || '').slice(0, 10) }}</span>
          </div>
        </van-radio-group>
        <p class="tip-line">可见项目以各项目AI表格中的「项目成员表」为准；未配到成员表的项目请联系项目管理员</p>
      </section>

      <template v-if="isAdminUser">
        <!-- 项目管理（Web管理端：新建/编辑/删除，填AI表格链接） -->
        <section class="card section">
          <div class="pm-head">
            <h3 class="section-title">项目管理 <span class="tip">共 {{ projectStore.projects.length }} 个</span></h3>
            <van-button size="small" type="primary" plain icon="plus" @click="openCreate">新建项目</van-button>
          </div>
          <div class="pm-item" v-for="p in projectStore.projects" :key="p.id">
            <div class="pm-info">
              <div class="pm-name">
                {{ p.name }}
                <van-tag v-if="p.id === projectStore.projectId" type="primary" plain size="medium">当前</van-tag>
              </div>
              <div class="pm-sub">日志表: {{ p.sheetId || '工作日志表' }} · 任务表: {{ p.taskSheetName || '任务表' }}</div>
            </div>
            <div class="pm-actions">
              <van-button size="small" plain type="primary" @click="openEdit(p)">编辑</van-button>
              <van-button size="small" plain type="danger" :loading="deletingId === p.id" @click="doDeleteProject(p)">
                删除
              </van-button>
            </div>
          </div>
          <p class="tip-line">成员以项目AI表格里「项目成员表」为准，无需在本系统重复维护人员</p>
        </section>

        <!-- 项目表单（弹层） -->
        <van-popup
          v-model:show="showProjectForm"
          position="bottom"
          round
          :style="{ maxHeight: '85%' }"
          closeable
        >
          <div class="form-wrap">
            <h3 class="form-title">{{ form.id ? '编辑项目' : '新建项目' }}</h3>
            <van-field v-model="form.name" label="项目名称" placeholder="如：城投AI协同" />
            <van-field
              v-model="form.baseId"
              label="AI表格链接"
              placeholder="粘贴钉钉文档链接或直接填 Base ID"
            />
            <van-field v-model="form.sheetId" label="日志表名" placeholder="工作日志表" />
            <van-field v-model="form.taskSheetName" label="任务表名" placeholder="任务表" />
            <van-field v-model="form.memberSheetName" label="成员表名" placeholder="项目成员表" />
            <van-field v-model="form.operatorUnionId" label="操作人ID" placeholder="操作人 UnionId（钉钉内打开自动获取，可不填）" />
            <div class="form-actions">
              <van-button size="small" plain :disabled="!form.id" :loading="testingProject" @click="doTestProject">
                测试连接
              </van-button>
              <van-button size="small" type="primary" :loading="savingProject" @click="saveProjectForm">
                保存项目
              </van-button>
            </div>
            <p class="tip-line">链接支持直接粘贴：alidocs.dingtalk.com/i/nodes/xxx 自动提取 Base ID</p>
          </div>
        </van-popup>

        <!-- 运行状态 -->
        <section class="card section">
          <h3 class="section-title">运行状态</h3>
          <p v-if="loginError" class="diag-line">登录诊断: {{ loginError }}</p>
          <div class="status-row">
            <span class="status-item">
              <van-tag :type="runtimeState.dingtalk ? 'success' : 'default'">
                {{ runtimeState.dingtalk ? '钉钉正式' : '本地演示' }}
              </van-tag>
              免登模式
            </span>
            <span class="status-item">
              <van-tag :type="runtimeState.table ? 'success' : 'default'">
                {{ runtimeState.table ? '已连接' : '本地存储' }}
              </van-tag>
              AI表格
            </span>
            <span class="status-item">
              <van-tag :type="runtimeState.ai ? 'success' : 'default'">
                {{ runtimeState.ai ? 'AI已启用' : '规则统计' }}
              </van-tag>
              智能查询
            </span>
          </div>
        </section>

        <!-- 标签库 -->
        <section class="card section">
          <h3 class="section-title">任务标签库 <span class="tip">用于自然语言解析识别</span></h3>
          <div class="tag-list">
            <van-tag
              v-for="(t, i) in tags"
              :key="t"
              type="primary"
              plain
              closeable
              size="large"
              @close="removeTag(i)"
            >
              {{ t }}
            </van-tag>
          </div>
          <div class="tag-add">
            <van-field v-model="newTag" placeholder="输入新标签" class="tag-input" @keyup.enter="addTag" />
            <van-button size="small" plain type="primary" @click="addTag">添加</van-button>
          </div>
        </section>

        <!-- AI 快捷提问 -->
        <section class="card section">
          <h3 class="section-title">AI 快捷提问 <span class="tip">每行一条</span></h3>
          <van-field
            v-model="suggestionsText"
            type="textarea"
            rows="3"
            autosize
            maxlength="200"
            placeholder="本周我完成了哪些任务？&#10;我有哪些未完成的任务？"
          />
        </section>

        <!-- 权限与防重 -->
        <section class="card section">
          <h3 class="section-title">权限与防重</h3>
          <van-field
            v-model="adminsText"
            label="管理员"
            type="textarea"
            rows="1"
            autosize
            placeholder="钉钉 userid，逗号分隔，可查看全员数据"
          />
          <van-field v-model="dedupSec" label="防重窗口(秒)" type="digit" placeholder="60" />
        </section>

        <!-- AI 智能查询（共性配置：全体用户共享） -->
        <section class="card section">
          <h3 class="section-title">AI 模型 <span class="tip">共性配置 · 全项目全用户共享，无需每人提供Key</span></h3>
          <van-cell center title="启用 AI 推理">
            <template #right-icon>
              <van-switch v-model="aiEnabled" size="20" />
            </template>
          </van-cell>
          <van-field label="提供商">
            <template #input>
              <select v-model="aiProvider" class="model-select" @change="onProviderChange">
                <option v-for="p in providers" :key="p.key" :value="p.key">
                  {{ p.label }}（{{ p.keyUrl.replace('https://', '') }}）
                </option>
              </select>
            </template>
          </van-field>
          <van-field label="模型">
            <template #input>
              <select v-model="aiModel" class="model-select">
                <option v-for="m in providerPreset.models" :key="m" :value="m">{{ m }}</option>
                <option v-if="!providerPreset.models.includes(aiModel)" :value="aiModel">{{ aiModel }}</option>
              </select>
            </template>
          </van-field>
          <van-field
            v-model="apiKeyInput"
            label="API Key"
            type="password"
            :placeholder="apiKeyMasked ? `当前: ${apiKeyMasked}，留空保持不变` : `在 ${providerPreset.keyUrl || '提供商控制台'} 申请`"
          />
          <p class="tip-line">推荐智谱 glm-4-flash（免费额度大）；填好 Key 打开开关即可启用</p>
        </section>

        <!-- 语音识别（讯飞，共性配置） -->
        <section class="card section">
          <h3 class="section-title">语音识别（讯飞听写） <span class="tip">共性配置 · 全员共享</span></h3>
          <van-cell center title="状态">
            <template #right-icon>
              <van-tag :type="asrEnabled ? 'success' : 'default'">
                {{ asrEnabled ? '已启用' : '未配置' }}
              </van-tag>
            </template>
          </van-cell>
          <van-field v-model="xfAppId" label="APPID" placeholder="讯飞开放平台应用的 APPID" />
          <van-field
            v-model="xfApiKeyInput"
            label="APIKey"
            type="password"
            :placeholder="xfApiKeyMasked ? `当前: ${xfApiKeyMasked}，留空保持不变` : '讯飞控制台 → 语音听写 WebAPI 的 APIKey'"
          />
          <van-field
            v-model="xfApiSecretInput"
            label="APISecret"
            type="password"
            :placeholder="xfApiSecretMasked ? `当前: ${xfApiSecretMasked}，留空保持不变` : '同页面的 APISecret'"
          />
          <p class="tip-line">
            传统引擎非大模型，免费额度每日500次；填写后按住说话即走讯飞，智谱ASR自动作为兜底
          </p>
        </section>

        <div class="save-bar safe-bottom">
          <van-button type="primary" block round :loading="saving" @click="save">保存并生效</van-button>
        </div>
      </template>

      <p v-else class="footer-tip safe-bottom">
        AI 模型与讯飞语音为系统共性配置，由管理员统一维护，无需个人提供 Key
      </p>
    </template>
  </div>
</template>

<style scoped>
.page-loading {
  padding: 60px 0;
}

.section {
  margin: 0 12px 12px;
}

.section-title {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
}

.section-title .tip {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-sub);
  margin-left: 6px;
}

.status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.status-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-sub);
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.tag-add {
  display: flex;
  gap: 8px;
  align-items: center;
}

.tag-input {
  flex: 1;
  background: #f7f8fa;
  border-radius: 8px;
  padding: 4px 0;
}

.model-select {
  border: none;
  background: transparent;
  font-size: 14px;
  color: var(--text-main);
  width: 100%;
}

.tip-line {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-sub);
}

.diag-line {
  margin: 0 0 8px;
  font-size: 11px;
  color: #ee0a24;
  word-break: break-all;
}

/* 项目切换 */
.project-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #f5f6f7;
}

.project-row:last-child {
  border-bottom: none;
}

.project-name {
  font-size: 14px;
  font-weight: 500;
}

.project-id {
  font-size: 11px;
  color: var(--text-sub);
  margin-left: 8px;
}

/* 项目管理 */
.pm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.pm-head .section-title {
  margin: 0;
}

.pm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid #f5f6f7;
}

.pm-item:last-of-type {
  border-bottom: none;
}

.pm-name {
  font-size: 14px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.pm-sub {
  font-size: 11px;
  color: var(--text-sub);
  margin-top: 2px;
}

.pm-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

/* 项目表单弹层 */
.form-wrap {
  padding: 20px 4px 24px;
}

.form-title {
  margin: 0 0 10px;
  padding: 0 16px;
  font-size: 16px;
  font-weight: 600;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
  padding: 0 16px;
}

.form-wrap .tip-line {
  padding: 0 16px;
}

.footer-tip {
  margin: 4px 16px 0;
  font-size: 11px;
  color: var(--text-sub);
  text-align: center;
}

.save-bar {
  padding: 4px 12px 80px;
}
</style>
