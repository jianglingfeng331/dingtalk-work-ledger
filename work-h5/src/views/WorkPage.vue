<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { enrichWork, getPlanOptions, getTasks, getWorkList, parsePlan, parseWork, runtime, submitPlan, submitWork } from '../api'
import { fmtDate } from '../utils/format'
import { initUser, userStore } from '../utils/user'
import { loadMyProjects, projectStore } from '../utils/project'

const content = ref('')
const submitting = ref(false)
const enriching = ref(false)
const records = ref([])
const loading = ref(false)
const refreshing = ref(false)
const filter = ref('all')

const filters = computed(() => {
  const base = [
    { key: 'all', label: '全部' },
    { key: 'today', label: '今日' },
    { key: 'week', label: '本周' },
    { key: 'undone', label: '未完成' },
  ]
  if (userStore.isAdmin) base.push({ key: 'all', label: '全员', team: 1 })
  return base
})

const teamView = ref(false)

const PROGRESS_META = {
  已完成: { color: '#07c160', bg: 'rgba(7, 193, 96, 0.1)' },
  进行中: { color: '#1677ff', bg: 'rgba(22, 119, 255, 0.1)' },
  未开始: { color: '#969799', bg: 'rgba(150, 151, 153, 0.12)' },
}

const progressColor = computed(() => (p) => PROGRESS_META[p]?.color || '#969799')

/** 当前项目名（多项目切换后随请求头生效，头部展示便于确认推送去向） */
const curProjectName = computed(
  () => projectStore.projects.find((p) => p.id === projectStore.projectId)?.name || '',
)

const today = fmtDate()

async function load() {
  loading.value = true
  try {
    const params = { scope: filter.value }
    if (teamView.value) params.team = 1
    records.value = (await getWorkList(params)) || []
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function setFilter(f) {
  const nextTeam = Boolean(f.team)
  if (filter.value === f.key && teamView.value === nextTeam) return
  filter.value = f.key
  teamView.value = nextTeam
  load()
}

/* ===================== 语音识别（长按说话） =====================
 * 三级引擎：WebSpeech 实时上屏 → 浏览器录音+云端转写 → 钉钉JSAPI录音+钉钉转写（容器内兜底）
 */
import { transcribeWav, WavRecorder } from '../utils/recorder'
import { DdAudioRecorder, ensureJsapiReady, isDingTalkEnv } from '../utils/dingtalk'
import { getToken } from '../utils/user'

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)
const speechSupported = Boolean(SR) && (typeof window !== 'undefined' ? window.isSecureContext !== false : true)
const recognizing = ref(false) // 按住中（任一引擎）
const transcribing = ref(false) // 松开后的云端转写中
const engine = ref('') // '' | 'web' | 'cloud' | 'dd'
let recognition = null
let pressTimer = null
let wavRecorder = null
let ddRecorder = null
let pendingStop = false // 松开时引擎尚未就绪：挂起，引擎就绪后立即停止+转写
let switchingCloud = false // switchToCloud 进行中（JSAPI签名/config 约需1-2秒）

function onTouchStart(e) {
  if (e.cancelable) e.preventDefault()
  startSpeech()
}

/** 长按开始：优先 WebSpeech，失败自动切云端录音 */
function startSpeech() {
  if (recognizing.value || transcribing.value) return
  clearTimeout(pressTimer)
  pressTimer = setTimeout(async () => {
    recognizing.value = true
    engine.value = ''

    // 引擎1：WebSpeech（谷歌服务，需可访问外网）
    if (speechSupported) {
      tryStartWebSpeech()
      // 给 WebSpeech 1.2s 启动窗口，期间报错/无响应则切云端
      setTimeout(async () => {
        if (recognizing.value && engine.value !== 'web' && engine.value !== 'cloud' && engine.value !== 'dd') await switchToCloud()
      }, 1200)
      return
    }
    await switchToCloud()
  }, 200)
}

function tryStartWebSpeech() {
  try {
    recognition = new SR()
  } catch {
    switchToCloud()
    return
  }
  recognition.lang = 'zh-CN'
  recognition.continuous = true
  recognition.interimResults = true
  recognition.onresult = (e) => {
    engine.value = 'web'
    let text = ''
    for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript
    if (text) content.value = text
  }
  recognition.onerror = (e) => {
    if (e.error === 'aborted' || e.error === 'no-speech' || e.error === 'audio-capture') return
    // service-not-allowed / network 等：WebSpeech 不可用 → 切云端
    if (recognizing.value && engine.value !== 'cloud') switchToCloud()
  }
  recognition.onend = () => {
    // 云端模式下忽略 web 引擎结束
  }
  try {
    recognition.start()
  } catch {
    switchToCloud()
  }
}

/** 钉钉JSAPI录音：停止并转写，成功后填入输入框 */
function finishDd(rec) {
  transcribing.value = true
  ;(async () => {
    try {
      const text = await rec.stopTranscribe()
      if (text) {
        content.value = text
        showToast('识别完成，可润色或直接拆解')
      } else {
        showToast('说话时间太短，请重试')
      }
    } catch (err) {
      showToast(err?.message || '语音识别失败')
    } finally {
      transcribing.value = false
    }
  })()
}

/** 浏览器录音：停止并云端转写，成功后填入输入框 */
function finishCloud(rec) {
  transcribing.value = true
  ;(async () => {
    try {
      const wav = await rec.stopWav()
      if (!wav) {
        showToast('说话时间太短，请重试')
        return
      }
      const text = await transcribeWav(wav, getToken())
      if (text) {
        content.value = text
        showToast('识别完成，可润色或直接拆解')
      } else {
        showToast('没有识别到内容，请重试')
      }
    } catch (err) {
      showToast(err?.message || '语音识别失败')
    } finally {
      transcribing.value = false
    }
  })()
}

/** 挂起中但引擎启动失败：解除挂起状态（错误提示由调用方toast） */
function cancelPendingStop() {
  if (!pendingStop) return
  pendingStop = false
  transcribing.value = false
}

/** 引擎就绪后若用户已松开：立即停止录音并转写（修复"录音完成文字没填入"的时序竞态） */
function settlePending() {
  if (!pendingStop) return
  pendingStop = false
  if (engine.value === 'dd' && ddRecorder) {
    const rec = ddRecorder
    ddRecorder = null
    finishDd(rec)
  } else if (engine.value === 'cloud' && wavRecorder) {
    const rec = wavRecorder
    wavRecorder = null
    finishCloud(rec)
  } else {
    transcribing.value = false
  }
}

/** 切换云端录音引擎（按住期间无缝切换）：浏览器录音优先，钉钉容器内兜底 JSAPI */
async function switchToCloud() {
  switchingCloud = true
  try {
    // 引擎2：浏览器录音（getUserMedia+MediaRecorder）
    if (WavRecorder.supported()) {
      try {
        await stopWebSpeechQuietly()
        wavRecorder = new WavRecorder()
        await wavRecorder.start()
        engine.value = 'cloud'
        settlePending()
        return
      } catch (err) {
        console.warn('[voice] 浏览器录音失败，尝试钉钉JSAPI:', err?.message)
      }
    }
    // 引擎3：钉钉 JSAPI 录音（webview 无浏览器录音 API 的设备）
    if (DdAudioRecorder.supported()) {
      try {
        await stopWebSpeechQuietly()
        ddRecorder = new DdAudioRecorder()
        // 达60秒上限钉钉自动结束：视同松开，直接转写填入
        ddRecorder.onAutoEnd = () => {
          if (engine.value === 'dd' && ddRecorder) {
            const rec = ddRecorder
            ddRecorder = null
            recognizing.value = false
            finishDd(rec)
          }
        }
        await ddRecorder.start()
        engine.value = 'dd'
        settlePending()
        return
      } catch (err) {
        console.warn('[voice] 钉钉JSAPI录音失败:', err?.message)
        ddRecorder = null
        recognizing.value = false
        cancelPendingStop()
        showToast(err?.message || '录音启动失败，请重试')
        return
      }
    }
    recognizing.value = false
    cancelPendingStop()
    showToast('当前环境不支持录音，请升级钉钉到最新版后重试')
  } finally {
    switchingCloud = false
  }
}

async function stopWebSpeechQuietly() {
  if (!recognition) return
  const r = recognition
  recognition = null
  r.onresult = null
  r.onerror = null
  r.onend = null
  try {
    r.abort()
  } catch {
    /* ignore */
  }
}

/** 松开：结束识别/录音；云端模式进入转写 */
function stopSpeech() {
  clearTimeout(pressTimer)
  if (!recognizing.value) return

  if (engine.value === 'dd' && ddRecorder) {
    recognizing.value = false
    const rec = ddRecorder
    ddRecorder = null
    finishDd(rec)
    return
  }

  if (engine.value === 'cloud' && wavRecorder) {
    recognizing.value = false
    const rec = wavRecorder
    wavRecorder = null
    finishCloud(rec)
    return
  }

  // 引擎尚未就绪（JSAPI签名/dd.config 进行中，约1-2秒）：挂起，引擎一就绪立即停止+转写。
  // 否则松开会被当作无事发生，录音空转到60秒上限自动结束、文字永远不填入。
  if (!engine.value && switchingCloud) {
    pendingStop = true
    recognizing.value = false
    transcribing.value = true
    return
  }

  // WebSpeech 模式或引擎未定：直接收尾
  recognizing.value = false
  stopWebSpeechQuietly()
}

onBeforeUnmount(() => {
  clearTimeout(pressTimer)
  stopWebSpeechQuietly()
  if (wavRecorder) {
    try {
      wavRecorder.stream?.getTracks().forEach((t) => t.stop())
      wavRecorder.recorder?.state !== 'inactive' && wavRecorder.recorder?.stop()
    } catch {
      /* ignore */
    }
    wavRecorder = null
  }
  ddRecorder?.abort()
  ddRecorder = null
  recognizing.value = false
  transcribing.value = false
})

/* ===================== 智能润色（可选） ===================== */
async function enrich() {
  const text = content.value.trim()
  if (!text) return showToast('请先输入或语音录入内容')
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

/* ===================== 任务选择（日志显式关联，替代智能匹配） ===================== */
const myTasks = ref([]) // 与当前用户相关的任务（负责人或参与人含本人）
const selectedTaskId = ref('') // 选中的任务记录ID；空=不指定，提交时由后端智能匹配
const showTaskPicker = ref(false)

const taskColumns = computed(() => [
  { text: '不指定（按内容智能匹配）', value: '' },
  ...myTasks.value.map((t) => ({ text: t.title, value: t.recordId })),
])

const selectedTaskTitle = computed(
  () => myTasks.value.find((t) => t.recordId === selectedTaskId.value)?.title || '',
)

/** 拉取"我的任务"：失败不阻断记日志，仅隐藏手选入口 */
async function loadMyTasks() {
  try {
    const res = await getTasks({ mine: 1 })
    if (res?.enabled === false) {
      myTasks.value = []
    } else {
      myTasks.value = res?.tasks || []
    }
    // 已选任务不在列表（被删/被移出）时清空，避免提交无效关联
    if (selectedTaskId.value && !myTasks.value.some((t) => t.recordId === selectedTaskId.value)) {
      selectedTaskId.value = ''
    }
  } catch {
    myTasks.value = []
  }
}

const onTaskConfirm = ({ selectedOptions }) => {
  selectedTaskId.value = selectedOptions[0]?.value || ''
  showTaskPicker.value = false
}

// 切换项目后任务清单要换，选择同步重置
watch(
  () => projectStore.projectId,
  () => {
    selectedTaskId.value = ''
    loadMyTasks()
  },
)

/* ===================== 智能拆解确认卡 ===================== */
const confirmVisible = ref(false)
const parsing = ref(false)
const confirmForm = ref({ content: '', progress: '未开始', hours: null })
const confirmMeta = ref({ taskDate: '', tags: [] })

/* 模块：log=工作日志（默认，入工作日志表） plan=计划（入任务表，需选负责人/节点/分类） */
const mode = ref('log')
const planForm = ref({ title: '', ownerName: '', planDate: '', category: '' })
const planMembers = ref([])
const planCategories = ref([])
const planParsed = ref(false) // 本内容是否已AI解析过（切模式只解析一次）
const planParsing = ref(false)
const showOwnerPicker = ref(false)
const showCategoryPicker = ref(false)
const showDatePopup = ref(false)

/** 拆解并打开确认卡（语音/文字统一入口） */
async function openConfirm() {
  const text = content.value.trim()
  if (!text) return showToast('请先输入工作内容')
  if (parsing.value || submitting.value) return
  parsing.value = true
  try {
    const parsed = await parseWork(text)
    confirmForm.value = {
      content: text,
      progress: parsed.progress || '未开始',
      hours: parsed.hours ?? null,
    }
    confirmMeta.value = { taskDate: parsed.taskDate || today, tags: parsed.tags || [] }
    mode.value = 'log'
    planParsed.value = false
    planForm.value = { title: '', ownerName: '', planDate: '', category: '' }
    confirmVisible.value = true
  } catch (err) {
    showFailToast(err?.message || '解析失败，请重试')
  } finally {
    parsing.value = false
  }
}

/** 切到计划模式：拉选项 + AI解析预填（同一内容只解析一次，之后用户随便改） */
async function switchMode(m) {
  if (mode.value === m) return
  mode.value = m
  if (m !== 'plan' || planParsed.value) return
  planParsing.value = true
  try {
    const [opts, parsed] = await Promise.all([
      planMembers.value.length ? Promise.resolve(null) : getPlanOptions(),
      parsePlan(content.value.trim()),
    ])
    if (opts?.members?.length) planMembers.value = opts.members
    if (opts?.categories?.length) planCategories.value = opts.categories
    planForm.value = {
      title: parsed?.title || content.value.trim().slice(0, 20),
      ownerName: parsed?.ownerName || '',
      planDate: parsed?.planDate || '',
      category: parsed?.category || '',
    }
  } catch (err) {
    // 解析失败不阻断：留空让用户手动填
    planForm.value.title = content.value.trim().slice(0, 20)
    showToast('AI解析未成功，请手动补充')
  } finally {
    planParsed.value = true
    planParsing.value = false
  }
}

/** 计划节点：van-date-picker值(['年','月','日']) ↔ YYYY-MM-DD */
const planDateArr = computed({
  get: () => {
    const s = planForm.value.planDate
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return [s.slice(0, 4), s.slice(5, 7), s.slice(8, 10)]
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return [String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())]
  },
  set: (arr) => {
    if (Array.isArray(arr) && arr.length === 3) planForm.value.planDate = arr.join('-')
  },
})

const onOwnerConfirm = ({ selectedOptions }) => {
  // 取value（纯姓名），text带角色后缀用于展示，不能作为提交值
  planForm.value.ownerName = selectedOptions[0]?.value || ''
  showOwnerPicker.value = false
}
const onCategoryConfirm = ({ selectedOptions }) => {
  planForm.value.category = selectedOptions[0]?.text || ''
  showCategoryPicker.value = false
}

/** 确认提交：日志→工作日志表；计划→任务表 */
async function confirmSubmit() {
  if (mode.value === 'plan') {
    if (!planForm.value.title.trim()) return showToast('请填写任务标题')
    if (!planForm.value.ownerName) return showToast('请选择负责人')
    if (submitting.value) return
    submitting.value = true
    try {
      const res = await submitPlan({
        title: planForm.value.title.trim(),
        ownerName: planForm.value.ownerName,
        planDate: planForm.value.planDate,
        category: planForm.value.category,
      })
      confirmVisible.value = false
      content.value = ''
      showSuccessToast(res?.__message || '计划已加入任务表')
    } catch (err) {
      showFailToast(err?.message || '提交失败，请重试')
    } finally {
      submitting.value = false
    }
    return
  }

  const text = confirmForm.value.content.trim()
  if (!text) return showToast('工作内容不能为空')
  if (submitting.value) return
  submitting.value = true
  try {
    const res = await submitWork(
      text,
      {
        progress: confirmForm.value.progress,
        hours: confirmForm.value.hours,
      },
      selectedTaskId.value, // 显式选择的任务：后端直接关联，跳过智能匹配
    )
    confirmVisible.value = false
    content.value = ''
    showSuccessToast(res?.__message || (runtime.mockMode ? '已记录（本地演示）' : '已同步钉钉AI表格'))
    await load()
  } catch (err) {
    showFailToast(err?.message || '提交失败，请重试')
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  // 预热钉钉JSAPI鉴权（取签名+dd.config约1-2秒）：进页面就做，长按时录音可立即启动
  if (isDingTalkEnv()) ensureJsapiReady().catch(() => {})
  await initUser()
  await loadMyProjects() // 项目就绪（自动选中默认项目）后再查询，避免首启空项目查0条导致页面空白
  loadMyTasks() // 后台拉"我的任务"供选择，不阻塞页面
  await load()
})
</script>

<template>
  <div class="page work-page">
    <!-- 固定头部 -->
    <header class="page-header">
      <div class="header-top">
        <div>
          <h1 class="page-title">
            工作台账
            <span v-if="curProjectName" class="proj-chip">{{ curProjectName }}</span>
          </h1>
          <p class="page-subtitle">{{ today }} · 一句话记录今天的工作</p>
        </div>
        <div class="user-chip">
          <van-icon name="manager-o" />
          <span class="name">{{ userStore.name || '加载中' }}</span>
          <van-tag v-if="runtime.mockMode" plain type="warning" size="mini">演示</van-tag>
        </div>
      </div>
    </header>

    <!-- 固定输入区：任务选择 + 文字输入 + 润色/拆解 -->
    <section class="card input-card">
      <!-- 关联任务：从任务表筛"我的任务"（负责人或参与人含本人）单选；不选则提交时智能匹配
           自定义行（非van-field）：固定高度+单行省略，选中/未选中行高严格一致 -->
      <div v-if="myTasks.length" class="task-bar" @click="showTaskPicker = true">
        <span class="tb-label">关联任务</span>
        <span class="tb-value" :class="{ empty: !selectedTaskTitle }">
          {{ selectedTaskTitle || '选择任务，不选则自动匹配' }}
        </span>
        <van-icon
          v-if="selectedTaskId"
          name="clear"
          class="tb-action"
          @click.stop="selectedTaskId = ''"
        />
        <van-icon v-else name="arrow" class="tb-action tb-arrow" />
      </div>
      <van-field
        v-model="content"
        type="textarea"
        rows="2"
        autosize
        maxlength="500"
        show-word-limit
        placeholder="语音录入或随手记一句，例如：上午和小王对齐了接口方案，花了3小时完成登录模块开发"
      />
      <div class="input-actions">
        <van-button size="small" plain round :loading="enriching" :disabled="!content.trim()" @click="enrich">
          智能润色
        </van-button>
        <van-button
          type="primary"
          round
          size="small"
          :loading="parsing"
          :disabled="!content.trim()"
          @click="openConfirm"
        >
          拆解确认
        </van-button>
      </div>
    </section>

    <!-- 固定筛选行 -->
    <section class="filter-row">
      <button
        v-for="f in filters"
        :key="f.label"
        class="chip"
        :class="{ active: filter === f.key && teamView === Boolean(f.team) }"
        @click="setFilter(f)"
      >
        {{ f.label }}
      </button>
    </section>

    <!-- 独立滚动的历史列表 -->
    <van-pull-refresh v-model="refreshing" class="list-scroll" @refresh="load">
      <div v-if="records.length" class="record-list">
        <article v-for="r in records" :key="r.id" class="card record-card">
          <div class="record-head">
            <span
              class="progress-dot"
              :style="{ background: PROGRESS_META[r.progress]?.color || '#969799' }"
            />
            <h3 class="record-title">{{ r.title }}</h3>
            <span class="progress-text" :style="{ color: progressColor(r.progress) }">
              {{ r.progress }}
            </span>
          </div>
          <p v-if="r.rawContent && r.rawContent !== r.title" class="record-raw">{{ r.rawContent }}</p>
          <div class="record-meta">
            <van-tag v-for="t in r.tags" :key="t" plain type="primary" size="medium">{{ t }}</van-tag>
            <span v-if="r.hours != null" class="hours-chip">{{ r.hours }}h</span>
            <span class="meta-text">{{ r.taskDate }} · {{ r.recorder }}</span>
          </div>
        </article>
      </div>
      <van-empty v-else :description="loading ? '加载中...' : '暂无工作记录，随手记一条吧'" />
    </van-pull-refresh>

    <!-- 底部固定：按住说话大按钮 -->
    <footer class="voice-bar safe-bottom">
      <div v-if="recognizing" class="voice-tip">
        <span class="pulse-dot" />{{ engine === 'cloud' ? '正在聆听（云端识别）' : '正在聆听' }}，说完松开
      </div>
      <div v-else-if="transcribing" class="voice-tip">
        <span class="pulse-dot cloud" />语音转写中...
      </div>
      <button
        class="hold-to-talk"
        :class="{ recording: recognizing, busy: transcribing }"
        :disabled="transcribing"
        :aria-label="recognizing ? '松开结束' : '按住说话'"
        @touchstart="onTouchStart"
        @touchend.prevent="stopSpeech"
        @touchcancel="stopSpeech"
        @mousedown.prevent="startSpeech"
        @mouseup.prevent="stopSpeech"
        @mouseleave="stopSpeech"
      >
        <van-icon :name="transcribing ? 'replay' : recognizing ? 'volume-o' : 'audio-o'" />
        <span>{{ transcribing ? '转写中' : recognizing ? '松开结束' : '按住说话' }}</span>
      </button>
      <p class="voice-hint">语音 → 文字 → 可润色 → 拆解确认提交</p>
    </footer>

    <!-- 智能拆解确认卡 -->
    <van-popup
      v-model:show="confirmVisible"
      position="bottom"
      round
      class="confirm-popup"
      :style="{ maxHeight: '82vh' }"
    >
      <div class="confirm-body">
        <h3 class="confirm-title">AI 已拆解，请确认</h3>

        <!-- 必选模块：日志→工作日志表；计划→任务表 -->
        <div class="mode-switch">
          <button class="mode-btn" :class="{ active: mode === 'log' }" @click="switchMode('log')">日志</button>
          <button class="mode-btn" :class="{ active: mode === 'plan' }" @click="switchMode('plan')">计划</button>
        </div>

        <!-- 日志模式 -->
        <template v-if="mode === 'log'">
          <div class="field-label">工作内容（可修改补充）</div>
          <van-field
            v-model="confirmForm.content"
            type="textarea"
            rows="3"
            autosize
            maxlength="500"
            class="confirm-input"
          />

          <!-- 所选关联任务回显（可在确认卡里改选）：单行省略+固定行高，选中/未选高度一致不跳动 -->
          <template v-if="myTasks.length">
            <div class="field-label">
              关联任务
              <van-tag plain type="primary" size="mini">{{ selectedTaskId ? '已选' : '未选·将智能匹配' }}</van-tag>
            </div>
            <div class="plan-cell task-cell" @click="showTaskPicker = true">
              <span class="task-name" :class="{ placeholder: !selectedTaskTitle }">
                {{ selectedTaskTitle || '点击选择任务' }}
              </span>
              <van-icon name="arrow" />
            </div>
          </template>

          <div class="field-label">完成情况</div>
          <div class="progress-picker">
            <button
              v-for="p in ['未开始', '进行中', '已完成']"
              :key="p"
              class="progress-option"
              :class="{ active: confirmForm.progress === p }"
              :style="confirmForm.progress === p ? { color: PROGRESS_META[p].color, background: PROGRESS_META[p].bg } : {}"
              @click="confirmForm.progress = p"
            >
              {{ p }}
            </button>
          </div>

          <div class="field-label">工时（小时，可不填）</div>
          <div class="hours-row">
            <van-stepper
              v-model="confirmForm.hours"
              :min="0"
              :max="24"
              :step="0.5"
              :decimal-length="1"
              allow-empty
              placeholder="未识别到"
            />
          </div>

          <div class="confirm-meta">
            <van-tag plain type="primary" size="medium">{{ confirmMeta.taskDate }}</van-tag>
            <van-tag v-for="t in confirmMeta.tags" :key="t" plain type="primary" size="medium">{{ t }}</van-tag>
          </div>
        </template>

        <!-- 计划模式 -->
        <template v-else>
          <div class="field-label">
            任务标题（可修改补充）
            <van-tag v-if="planParsing" plain type="primary" size="mini">AI解析中…</van-tag>
          </div>
          <van-field
            v-model="planForm.title"
            type="textarea"
            rows="2"
            autosize
            maxlength="50"
            class="confirm-input"
            placeholder="AI未能识别，请填写任务标题"
          />

          <div class="field-label">负责人（必选，来自项目成员表）</div>
          <div class="plan-cell" @click="showOwnerPicker = true">
            <span :class="{ placeholder: !planForm.ownerName }">
              {{ planForm.ownerName || '点击选择负责人' }}
            </span>
            <van-icon name="arrow" />
          </div>

          <div class="field-label">计划节点（必选）</div>
          <div class="plan-cell" @click="showDatePopup = true">
            <span :class="{ placeholder: !planForm.planDate }">
              {{ planForm.planDate || '点击选择计划节点日期' }}
            </span>
            <van-icon name="arrow" />
          </div>

          <div class="field-label">任务分类（必选）</div>
          <div class="plan-cell" @click="showCategoryPicker = true">
            <span :class="{ placeholder: !planForm.category }">
              {{ planForm.category || '点击选择任务分类' }}
            </span>
            <van-icon name="arrow" />
          </div>
        </template>

        <div class="confirm-actions safe-bottom">
          <van-button block round plain @click="confirmVisible = false">取消</van-button>
          <van-button block round type="primary" :loading="submitting" @click="confirmSubmit">
            {{ mode === 'plan' ? '提交到任务表' : '确认提交' }}
          </van-button>
        </div>
      </div>
    </van-popup>

    <!-- 日志：关联任务选择（我的任务单选） -->
    <van-popup v-model:show="showTaskPicker" position="bottom" round>
      <van-picker
        title="选择关联任务"
        :columns="taskColumns"
        @confirm="onTaskConfirm"
        @cancel="showTaskPicker = false"
      />
    </van-popup>

    <!-- 计划：负责人选择 -->
    <van-popup v-model:show="showOwnerPicker" position="bottom" round>
      <van-picker
        title="选择负责人"
        :columns="planMembers.map((m) => ({ text: m.roles?.length ? `${m.name}（${m.roles[0]}）` : m.name, value: m.name }))"
        @confirm="onOwnerConfirm"
        @cancel="showOwnerPicker = false"
      />
    </van-popup>

    <!-- 计划：任务分类选择 -->
    <van-popup v-model:show="showCategoryPicker" position="bottom" round>
      <van-picker
        title="选择任务分类"
        :columns="planCategories.map((c) => ({ text: c, value: c }))"
        @confirm="onCategoryConfirm"
        @cancel="showCategoryPicker = false"
      />
    </van-popup>

    <!-- 计划：计划节点日期 -->
    <van-popup v-model:show="showDatePopup" position="bottom" round>
      <van-date-picker
        title="选择计划节点"
        v-model="planDateArr"
        :min-date="new Date(Date.now() - 86400000)"
        :max-date="new Date(Date.now() + 365 * 86400000)"
        @confirm="showDatePopup = false"
        @cancel="showDatePopup = false"
      />
    </van-popup>
  </div>
</template>

<style scoped>
/* 当前项目小徽标：头部标题旁，展示日志/计划推送去向 */
.proj-chip {
  display: inline-block;
  vertical-align: 2px;
  margin-left: 6px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 400;
  color: #1677ff;
  background: rgba(22, 119, 255, 0.08);
  border-radius: 999px;
}

/* 整页三段式：固定头部+输入+筛选，列表独立滚动，底部语音栏 */
.work-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

.page-header,
.input-card,
.filter-row {
  flex-shrink: 0;
}

.input-card {
  margin: 0 12px;
}

.input-card :deep(.van-field) {
  padding: 8px 0 2px; /* 底部交给操作行的上边距，避免按钮贴住输入文字 */
}

/* 关联任务选择行（输入区）：固定40px行盒+单行省略，选中长名与未选中高度严格一致 */
.task-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px; /* 锁死高度，杜绝任何状态下的跳动 */
  margin: 2px 0 6px;
  padding: 0 10px;
  background: #f7f8fa;
  border-radius: 8px;
  cursor: pointer;
}
.tb-label {
  flex-shrink: 0;
  font-size: 13px;
  color: #646566;
}
.tb-value {
  flex: 1;
  min-width: 0; /* flex子项允许收缩，省略号生效的前提 */
  font-size: 14px;
  line-height: 20px;
  color: var(--text-main, #323233);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tb-value.empty {
  color: #c8c9cc;
  font-size: 13px;
}
.tb-action {
  flex-shrink: 0;
  padding: 6px;
  font-size: 16px;
  color: #c8c9cc;
}
.tb-action.tb-arrow {
  color: #c8c9cc;
}

.input-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

/* 列表独立滚动 */
.list-scroll {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.record-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 12px 12px;
}

/* 底部语音栏（固定于 tabbar 上方） */
.voice-bar {
  flex-shrink: 0;
  padding: 10px 16px 8px;
  margin-bottom: calc(50px + env(safe-area-inset-bottom));
  background: var(--page-bg);
  text-align: center;
}

.hold-to-talk {
  width: 100%;
  border: none;
  border-radius: 999px;
  padding: 13px 0;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #1677ff, #4d94ff);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-shadow: 0 4px 12px rgba(22, 119, 255, 0.25);
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

.hold-to-talk .van-icon {
  font-size: 18px;
}

.hold-to-talk.recording {
  background: linear-gradient(135deg, #07c160, #23d378);
  box-shadow: 0 4px 12px rgba(7, 193, 96, 0.3);
  animation: mic-pulse 1.2s ease-in-out infinite;
}

.hold-to-talk.busy {
  opacity: 0.7;
}

@keyframes mic-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.03); }
}

.voice-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: #07c160;
  margin-bottom: 6px;
}

.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #07c160;
  animation: mic-pulse 1s infinite;
}

.pulse-dot.cloud {
  background: #1677ff;
}

.voice-hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-sub);
}

.filter-row {
  display: flex;
  gap: 8px;
  padding: 12px 12px 4px;
}

.chip {
  border: none;
  padding: 5px 14px;
  border-radius: 999px;
  background: #fff;
  color: var(--text-sub);
  font-size: 12px;
}

.chip.active {
  background: rgba(22, 119, 255, 0.12);
  color: var(--primary);
  font-weight: 600;
}

.record-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.record-title {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.progress-text {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
}

.record-raw {
  margin: 6px 0 0 16px;
  font-size: 13px;
  color: var(--text-sub);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.record-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0 16px;
}

.hours-chip {
  font-size: 11px;
  color: #ff976a;
  font-weight: 600;
}

.meta-text {
  font-size: 11px;
  color: var(--text-sub);
  margin-left: auto;
}

/* 确认弹层 */
.confirm-popup {
  padding-bottom: env(safe-area-inset-bottom);
}

.confirm-body {
  padding: 20px 16px 16px;
}

.confirm-title {
  margin: 0 0 14px;
  font-size: 16px;
  font-weight: 700;
  text-align: center;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
  margin: 12px 0 6px;
}

/* 必选模块切换：日志/计划 */
.mode-switch {
  display: flex;
  gap: 8px;
  margin: 12px 0 4px;
}

.mode-btn {
  flex: 1;
  height: 38px;
  border: 1px solid #ebedf0;
  border-radius: 8px;
  background: #f7f8fa;
  font-size: 14px;
  color: var(--text-sub, #646566);
}

.mode-btn.active {
  border-color: #1677ff;
  background: #ecf5ff;
  color: #1677ff;
  font-weight: 600;
}

/* 计划模式：选择单元格（负责人/节点/分类） */
.plan-cell {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 10px;
  background: #f7f8fa;
  border-radius: 8px;
  font-size: 14px;
  color: var(--text-main);
}

.plan-cell .placeholder {
  color: #c8c9cc;
}

/* 关联任务选择行（确认卡）：固定行盒+单行省略，选中长名与未选中高度完全一致，避免确认卡内容跳动 */
.plan-cell.task-cell {
  height: 44px; /* 固定高度（非min-height）：内容再长也不许撑高 */
  overflow: hidden;
  box-sizing: border-box;
}
.task-cell .task-name {
  flex: 1;
  min-width: 0; /* flex子项允许收缩，省略号才能生效 */
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.confirm-input {
  background: #f7f8fa;
  border-radius: 10px;
  padding: 4px 0;
}

.progress-picker {
  display: flex;
  gap: 8px;
}

.progress-option {
  flex: 1;
  border: 1px solid #ebedf0;
  background: #fff;
  border-radius: 10px;
  padding: 9px 0;
  font-size: 13px;
  color: var(--text-sub);
}

.progress-option.active {
  font-weight: 700;
  border-color: transparent;
}

.hours-row {
  display: flex;
}

.confirm-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.confirm-actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
  padding-bottom: 8px;
}
</style>
