<script setup>
import { computed, onMounted, ref } from 'vue'
import { closeToast, showConfirmDialog, showFailToast, showLoadingToast, showSuccessToast } from 'vant'
import { approveProjectApi, createDesktopTokenApi, deleteProjectApi, getDesktopTokenApi, getProjectMembers, getProjects, getSettings, rejectProjectApi, revokeDesktopTokenApi, saveProjectApi, testProject, updateSettings } from '../api'
import { initUser, userStore } from '../utils/user'
import { fixCurrentProject, isJoined, projectStore, setCurrentProject } from '../utils/project'

const loading = ref(true)
const saving = ref(false)
const isAdminUser = ref(false)

const runtimeState = ref({ dingtalk: false, table: false, ai: false })

// 桌面版（秒建功）令牌管理
const desktopToken = ref({ created: false, masked: '', name: '', plain: '' })
const tokenLoading = ref(false)
async function createDesktopToken() {
  tokenLoading.value = true
  try {
    const res = await createDesktopTokenApi()
    Object.assign(desktopToken.value, { created: true, plain: res.token, masked: '', name: res.name || '我' })
    showSuccessToast('已生成，请立即复制（仅本次显示）')
  } catch (e) {
    showFailToast(e?.message || '生成失败')
  } finally {
    tokenLoading.value = false
  }
}
async function revokeDesktopToken() {
  try {
    await showConfirmDialog({ title: '撤销桌面令牌', message: '撤销后桌面版将立即无法登录，确定？' })
  } catch {
    return
  }
  try {
    await revokeDesktopTokenApi()
    Object.assign(desktopToken.value, { created: false, masked: '', plain: '' })
    showSuccessToast('已撤销')
  } catch (e) {
    showFailToast(e?.message || '撤销失败')
  }
}

/** 复制文本到剪贴板（降级 execCommand） */
function copyText(text) {
  const done = () => showSuccessToast('已复制')
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
  } else fallbackCopy(text, done)
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
    done()
  } catch {
    showFailToast('复制失败，请长按手动复制')
  }
  ta.remove()
}

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

// 启动诊断：上次Vue挂载时间 + 入口脚本加载失败记录（排查钉钉首进白屏的关键证据）
const bootDiag = ref('')

/* ===================== 项目管理（管理员） ===================== */
const showProjectForm = ref(false)
const savingProject = ref(false)
const testingProject = ref(false)
const deletingId = ref('')
const approvingId = ref('')
const rejectingId = ref('')
const pendingProjects = ref([]) // 待管理员审核的项目（普通用户仅见自己提交的）
const editingPending = ref(false) // 正在编辑待审核项目：允许暂无AI表格地址（审批时自动建）
const form = ref({
  id: '',
  name: '',
  baseId: '',
  sheetId: '工作日志表',
  taskSheetName: '任务表',
  memberSheetName: '项目成员表',
  operatorUnionId: '',
  leaders: [], // [{name, unionId}] 领导角色：命中者在移动端可见「下达指令」
  aliases: '', // 项目别名（逗号分隔）：口语化叫法路由用，如"城投ai项目,ai协同项目"
})

// 领导角色设置：姓名输入 + 成员表匹配建议
const leaderInput = ref('')
const projectMembers = ref([]) // 编辑项目时拉取的成员表（姓名匹配验证源）
const memberMatches = computed(() => {
  const kw = leaderInput.value.trim()
  if (!kw) return []
  const picked = new Set(form.value.leaders.map((l) => l.name))
  return projectMembers.value
    .filter((m) => m.name.includes(kw) && !picked.has(m.name))
    .slice(0, 6)
})

function addLeader(m) {
  if (form.value.leaders.length >= 10) return showFailToast('最多设置10位领导')
  if (form.value.leaders.some((l) => l.name === m.name)) return
  form.value.leaders.push({ name: m.name, unionId: m.unionId || '' })
  leaderInput.value = ''
}

function removeLeader(i) {
  form.value.leaders.splice(i, 1)
}

/** 拉项目成员表（领导姓名匹配验证；新建项目读不到，靠后端保存时校验） */
async function loadMembersForForm() {
  projectMembers.value = []
  if (!form.value.id) return
  try {
    const res = await getProjectMembers(form.value.id)
    projectMembers.value = res.members || []
  } catch {
    /* 读不到成员表时仍可手填姓名，保存时后端校验 */
  }
}

const providerPreset = computed(
  () => providers.value.find((p) => p.key === aiProvider.value) || { models: [], defaultModel: '' },
)

async function load() {
  loading.value = true
  try {
    await initUser()
    // 项目列表：展示平台全部项目（普通用户附 member 标识，非成员仅展示不可切换）
    const pres = await getProjects().catch(() => ({ projects: [] }))
    projectStore.projects = pres.projects || []
    pendingProjects.value = pres.pendingProjects || []
    fixCurrentProject()
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
      // 桌面版令牌状态（脱敏）
      getDesktopTokenApi()
        .then((d) => Object.assign(desktopToken.value, d, { plain: '' }))
        .catch(() => {})
    }
    try {
      const d = JSON.parse(localStorage.getItem('last_login_error') || 'null')
      if (d?.msg) {
        loginError.value = `[${d.time}·${d.env}·corpId${d.corpId || '未知'}] ${d.msg}`
      }
    } catch {
      /* ignore */
    }
    try {
      const parts = []
      const entry = document.querySelector('script[type="module"][src]')?.getAttribute('src') || ''
      if (entry) parts.push(`当前入口 ${entry.split('/').pop()}`)
      const mount = localStorage.getItem('work_last_mount')
      if (mount) parts.push(`上次挂载 ${mount}`)
      const entryErr = JSON.parse(localStorage.getItem('work_last_entry_error') || 'null')
      if (entryErr?.src) parts.push(`入口JS加载失败 ${entryErr.time} (${entryErr.src.split('/').pop()})`)
      bootDiag.value = parts.join('；') || '无记录（可能仍在旧版本，请刷新一次）'
    } catch {
      /* ignore */
    }
  } finally {
    loading.value = false
  }
}

/** 切换当前项目：所有页面数据按项目隔离，切换后整页刷新加载新项目数据（非成员项目不可切换） */
function switchProject(id) {
  if (!id || id === projectStore.projectId) return
  const target = projectStore.projects.find((x) => x.id === id)
  if (!isJoined(target)) return showFailToast('你不在该项目成员表中，无法切换')
  setCurrentProject(id)
  showSuccessToast('已切换项目，正在刷新...')
  setTimeout(() => location.reload(), 600)
}

function openCreate() {
  form.value = {
    id: '',
    name: '',
    baseId: '',
    autoCreateTable: true, // 新建默认自动建表；关闭则手工粘贴链接
    sheetId: '工作日志表',
    taskSheetName: '任务表',
    memberSheetName: '项目成员表',
    operatorUnionId: '',
    leaders: [],
    aliases: '',
  }
  leaderInput.value = ''
  projectMembers.value = []
  editingPending.value = false
  showProjectForm.value = true
}

function openEdit(p) {
  form.value = {
    id: p.id,
    name: p.name || '',
    baseId: p.baseId || '',
    autoCreateTable: false, // 编辑时表格已存在，隐藏开关
    sheetId: p.sheetId || '工作日志表',
    taskSheetName: p.taskSheetName || '任务表',
    memberSheetName: p.memberSheetName || '项目成员表',
    operatorUnionId: p.operatorUnionId || '',
    leaders: (p.leaders || []).map((l) => ({ name: l.name, unionId: l.unionId || '' })),
    aliases: (p.aliases || []).join('，'),
  }
  leaderInput.value = ''
  editingPending.value = p.status === 'pending'
  showProjectForm.value = true
  loadMembersForForm()
}

async function saveProjectForm() {
  if (savingProject.value) return
  const f = form.value
  if (!f.name.trim()) return showFailToast('请填写项目名称')
  const autoCreate = !f.id && f.autoCreateTable && !f.baseId.trim()
  // 待审核项目走自动建表时暂无地址，审批通过时由服务端补建
  if (!autoCreate && !f.baseId.trim() && !editingPending.value) return showFailToast('请填写AI表格链接或Base ID')
  savingProject.value = true
  showLoadingToast({
    // 普通用户不立即建表（审核通过时才建），仅管理员新建走即时建表
    message: autoCreate && isAdminUser.value ? '正在自动创建AI表格…' : '正在保存…',
    forbidClick: true,
    duration: 0,
  })
  try {
    const res = await saveProjectApi({
      ...f,
      name: f.name.trim(),
      baseId: f.baseId.trim(),
      aliases: String(f.aliases || '').trim(),
    })
    closeToast()
    showSuccessToast(res?.message || (f.id ? '项目已更新' : '项目已创建'))
    showProjectForm.value = false
    await refreshProjects()
  } catch (err) {
    closeToast()
    showFailToast(err?.message || '保存失败')
  } finally {
    savingProject.value = false
  }
}

/** 刷新项目列表与待审核列表（保存/删除/审批后统一调用） */
async function refreshProjects() {
  const pres = await getProjects().catch(() => null)
  if (!pres) return
  projectStore.projects = pres.projects || []
  pendingProjects.value = pres.pendingProjects || []
  fixCurrentProject()
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
    await refreshProjects()
  } catch (err) {
    showFailToast(err?.message || '删除失败')
  } finally {
    deletingId.value = ''
  }
}

/** 审核通过（仅管理员）：勾了自动建表的待审核项目在审批时建表（约5-15秒） */
async function doApprove(p) {
  if (approvingId.value) return
  approvingId.value = p.id
  showLoadingToast({
    message: p.pendingAutoCreate && !p.baseId ? '正在自动创建AI表格…' : '审核中…',
    forbidClick: true,
    duration: 0,
  })
  try {
    const res = await approveProjectApi(p.id)
    closeToast()
    showSuccessToast(res?.message || '已通过审核')
    await refreshProjects()
  } catch (err) {
    closeToast()
    showFailToast(err?.message || '审核失败')
  } finally {
    approvingId.value = ''
  }
}

/** 拒绝审核（仅管理员）：移除该项目配置 */
async function doReject(p) {
  try {
    await showConfirmDialog({
      title: '拒绝项目',
      message: `确定拒绝「${p.name}」？\n项目配置将被移除，提交人需重新发起。`,
    })
  } catch {
    return
  }
  rejectingId.value = p.id
  try {
    const res = await rejectProjectApi(p.id)
    showSuccessToast(res?.message || '已拒绝')
    await refreshProjects()
  } catch (err) {
    showFailToast(err?.message || '操作失败')
  } finally {
    rejectingId.value = ''
  }
}

/** 点击项目名称复制AI表格地址（待审核自动建表的项目暂无地址） */
async function copyTableUrl(p) {
  if (!p.baseId) return showFailToast('该项目暂无AI表格地址（待审核自动建表）')
  const url = `https://alidocs.dingtalk.com/i/nodes/${p.baseId}`
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
    } else {
      // 旧内核兜底：隐藏输入框 + execCommand
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
      <!-- 项目列表（所有用户：展示平台全部项目，成员项目可点击切换） -->
      <section class="card section">
        <h3 class="section-title">项目列表 <span class="tip">共 {{ projectStore.projects.length }} 个 · 切换后日志计划推送到所选项目</span></h3>
        <van-empty
          v-if="!projectStore.projects.length"
          image="search"
          description="平台暂无项目，可在下方「项目管理」新建（需管理员审核）"
        />
        <van-radio-group v-else :model-value="projectStore.projectId" @update:model-value="switchProject">
          <div
            class="project-row"
            :class="{ 'not-member': !isJoined(p) }"
            v-for="p in projectStore.projects"
            :key="p.id"
          >
            <van-radio :name="p.id" :disabled="!isJoined(p)">
              <span class="project-name">{{ p.name }}</span>
            </van-radio>
            <van-tag v-if="!isJoined(p)" class="join-tag" plain size="medium">未加入</van-tag>
            <span v-else class="project-id">{{ (p.baseId || '').slice(0, 10) }}</span>
          </div>
        </van-radio-group>
        <p class="tip-line">展示平台全部项目；能否切换以各项目AI表格「项目成员表」为准，未加入的项目请联系项目管理员</p>
      </section>

      <!-- 项目管理（所有用户可新建/编辑；删除与审核仅管理员） -->
      <section class="card section">
        <div class="pm-head">
          <h3 class="section-title">
            项目管理
            <span class="tip">
              共 {{ projectStore.projects.length }} 个<template v-if="pendingProjects.length"> · 待审核 {{ pendingProjects.length }} 个</template>
            </span>
          </h3>
          <van-button size="small" type="primary" plain icon="plus" @click="openCreate">新建项目</van-button>
        </div>
        <!-- 待审核（管理员可审批；普通用户仅见自己提交的） -->
        <div class="pm-item" v-for="p in pendingProjects" :key="p.id">
          <div class="pm-info">
            <div class="pm-name">
              <span class="pm-name-link" @click="copyTableUrl(p)">{{ p.name }}</span>
              <van-tag type="warning" plain size="medium">待审核</van-tag>
            </div>
            <div class="pm-sub">
              提交人: {{ p.createdBy?.name || '—' }}{{ isAdminUser ? '' : ' · 管理员审核通过后即可使用' }}
            </div>
          </div>
          <div class="pm-actions">
            <van-button size="small" plain type="primary" @click="openEdit(p)">编辑</van-button>
            <template v-if="isAdminUser">
              <van-button size="small" plain type="primary" :loading="approvingId === p.id" @click="doApprove(p)">
                同意
              </van-button>
              <van-button size="small" plain type="danger" :loading="rejectingId === p.id" @click="doReject(p)">
                拒绝
              </van-button>
            </template>
          </div>
        </div>
        <div class="pm-item" v-for="p in projectStore.projects" :key="p.id">
          <div class="pm-info">
            <div class="pm-name">
              <span class="pm-name-link" @click="copyTableUrl(p)">{{ p.name }}</span>
              <van-tag v-if="p.id === projectStore.projectId" type="primary" plain size="medium">当前</van-tag>
            </div>
            <div class="pm-sub">日志表: {{ p.sheetId || '工作日志表' }} · 任务表: {{ p.taskSheetName || '任务表' }}</div>
          </div>
          <div class="pm-actions">
            <van-button size="small" plain type="primary" @click="openEdit(p)">编辑</van-button>
            <van-button
              v-if="isAdminUser"
              size="small"
              plain
              type="danger"
              :loading="deletingId === p.id"
              @click="doDeleteProject(p)"
            >
              删除
            </van-button>
          </div>
        </div>
        <p class="tip-line">
          点击项目名称复制AI表格地址；{{ isAdminUser ? '新建即生效' : '新建后需管理员审核' }}；成员以项目AI表格里「项目成员表」为准
        </p>
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
              v-model="form.aliases"
              label="项目别名"
              placeholder="口语化叫法，逗号分隔，如：城投ai项目,ai协同项目"
            />
            <van-field v-if="!form.id" label="自动建表">
              <template #input>
                <van-switch v-model="form.autoCreateTable" size="22px" />
              </template>
            </van-field>
            <van-field
              v-if="form.id || !form.autoCreateTable"
              v-model="form.baseId"
              label="AI表格链接"
              placeholder="粘贴钉钉文档链接或直接填 Base ID"
            />
            <p v-else class="tip-line">
              {{
                isAdminUser
                  ? '保存时将自动在知识库创建AI表格及四张标准数据表，无需粘贴链接'
                  : '提交后等待管理员审核，审核通过时自动创建AI表格及四张标准数据表'
              }}
            </p>
            <van-field v-model="form.sheetId" label="日志表名" placeholder="工作日志表" />
            <van-field v-model="form.taskSheetName" label="任务表名" placeholder="任务表" />
            <van-field v-model="form.memberSheetName" label="成员表名" placeholder="项目成员表" />
            <van-field v-model="form.operatorUnionId" label="操作人ID" placeholder="操作人 UnionId（钉钉内打开自动获取，可不填）" />
            <!-- 领导角色设置：姓名与项目成员表（钉钉用户）匹配验证 -->
            <div class="leader-block">
              <p class="leader-label">领导角色设置（可下达指令，最多10位）</p>
              <van-field
                v-model="leaderInput"
                label="添加领导"
                placeholder="输入姓名，从成员表匹配选择"
                :disabled="!projectMembers.length && !!form.id"
              />
              <div v-if="memberMatches.length" class="leader-suggest">
                <button v-for="m in memberMatches" :key="m.name" type="button" class="leader-suggest-item" @click="addLeader(m)">
                  {{ m.name }}<span v-if="m.roles?.length" class="leader-suggest-role">{{ m.roles.join('、') }}</span>
                </button>
              </div>
              <div v-if="form.leaders.length" class="leader-tags">
                <van-tag
                  v-for="(l, i) in form.leaders"
                  :key="l.name"
                  closeable
                  type="primary"
                  plain
                  @close="removeLeader(i)"
                >
                  {{ l.name }}
                </van-tag>
              </div>
              <p class="tip-line">
                {{
                  form.id
                    ? projectMembers.length
                      ? '领导姓名已与钉钉成员表匹配验证，保存后该成员在移动端可下达指令'
                      : '正在读取成员表…读不到时可先保存后重新编辑验证'
                    : '新项目保存后再编辑，可从成员表匹配验证领导姓名'
                }}
              </p>
            </div>
            <div class="form-actions">
              <van-button
                v-if="isAdminUser"
                size="small"
                plain
                :disabled="!form.id"
                :loading="testingProject"
                @click="doTestProject"
              >
                测试连接
              </van-button>
              <van-button size="small" type="primary" :loading="savingProject" @click="saveProjectForm">
                {{ !form.id && !isAdminUser ? '提交审核' : '保存项目' }}
              </van-button>
            </div>
            <p class="tip-line">链接支持直接粘贴：alidocs.dingtalk.com/i/nodes/xxx 自动提取 Base ID</p>
          </div>
        </van-popup>

      <!-- 运行状态起为管理员专属配置 -->
      <template v-if="isAdminUser">
        <!-- 运行状态 -->
        <section class="card section">
          <h3 class="section-title">运行状态</h3>
          <p v-if="loginError" class="diag-line">登录诊断: {{ loginError }}</p>
          <p class="diag-line">启动诊断: {{ bootDiag }}</p>
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

        <!-- 桌面版（秒建功）令牌 -->
        <section class="card section">
          <h3 class="section-title">桌面版 · 秒建功 <span class="tip">电脑桌宠 · 右键切项目 · 点击对话/填报</span></h3>
          <p class="tip-line">
            生成令牌后，在桌面版「设置」中填入服务器地址与令牌即可登录（身份绑定你）。
            令牌仅生成时显示一次，重新生成会立即使旧令牌失效。
          </p>
          <div v-if="desktopToken.created" class="status-row" style="margin-bottom: 8px">
            <span class="status-item">
              <van-tag type="success">已生成</van-tag>
              {{ desktopToken.masked }}（{{ desktopToken.name }}）
            </span>
          </div>
          <div v-if="desktopToken.plain" class="token-box">
            <code>{{ desktopToken.plain }}</code>
            <van-button size="small" type="primary" plain @click="copyText(desktopToken.plain)">复制</van-button>
          </div>
          <div class="token-actions">
            <van-button size="small" type="primary" :loading="tokenLoading" @click="createDesktopToken">
              {{ desktopToken.created ? '重新生成' : '生成桌面令牌' }}
            </van-button>
            <van-button v-if="desktopToken.created" size="small" type="danger" plain @click="revokeDesktopToken">
              撤销
            </van-button>
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

/* 桌面版令牌卡片 */
.token-box {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
  padding: 8px 10px;
  background: #f4f8ff;
  border-radius: 8px;
}
.token-box code {
  flex: 1;
  word-break: break-all;
  font-size: 11px;
  color: #1677ff;
}
.token-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
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

/* 非成员项目：置灰仅展示 */
.project-row.not-member {
  opacity: 0.6;
}

.join-tag {
  flex-shrink: 0;
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

/* 项目名称：点击复制AI表格地址 */
.pm-name-link {
  cursor: pointer;
  border-bottom: 1px dashed var(--text-sub, #c8c9cc);
}

.pm-name-link:active {
  opacity: 0.6;
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

/* 领导角色设置模块 */
.leader-block {
  margin: 8px 12px 4px;
  padding: 10px 4px 4px;
  border-top: 1px dashed #e5e6eb;
}

.leader-label {
  margin: 0 0 4px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--text-sub, #969799);
}

.leader-suggest {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 12px;
}

.leader-suggest-item {
  border: none;
  border-radius: 8px;
  background: #f2f3f5;
  padding: 6px 10px;
  font-size: 13px;
  color: #323233;
}

.leader-suggest-role {
  margin-left: 4px;
  font-size: 11px;
  color: #969799;
}

.leader-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 12px;
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
