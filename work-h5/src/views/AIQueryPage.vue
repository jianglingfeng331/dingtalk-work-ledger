<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { aiQuery, getSettings, runtime } from '../api'
import { initUser } from '../utils/user'
import avatarImg from '../assets/ai-avatar.png'

const messages = ref([
  {
    role: 'ai',
    text: '你好，我是 AI老谢。可以直接问我工作数据，例如「本周我完成了哪些任务？」，我会基于团队台账给你统计与复盘。',
  },
])
const input = ref('')
const sending = ref(false)
const listEl = ref(null)

// 快捷提问：来自系统动态配置（设置页可改）
const suggestions = ref(['本周我完成了哪些任务？', '我有哪些未完成的任务？', '团队本周工作汇总'])

const onlyWelcome = () => messages.value.length === 1

/** 发起 AI 查询：后端 MCP 拉取台账实时数据 + 智谱 LLM 推理（正式链路，失败明确提示） */
async function send(q) {
  const question = (q ?? input.value).trim()
  if (!question || sending.value) return
  input.value = ''
  messages.value.push({ role: 'user', text: question })
  const aiMsg = { role: 'ai', text: '', loading: true }
  messages.value.push(aiMsg)
  sending.value = true
  scrollToBottom()
  try {
    aiMsg.text = await aiQuery(question)
  } catch (err) {
    aiMsg.text = '查询失败：' + (err?.message || '请稍后重试')
  } finally {
    aiMsg.loading = false
    sending.value = false
    scrollToBottom()
  }
}

function scrollToBottom() {
  nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/* 键盘适配 v8 三分支全覆盖（钉钉安卓webview行为不可预知）：
   A. 视口会压缩（resizes-content/正常resize）→ 轮询测到高度骤降 → 锁页高，输入框贴键盘上方
   B. 完全无事件（覆盖式键盘，盖住底部）→ 1秒内没测到压缩 → 输入框钉到页面顶部（键盘永远盖不住顶部）
   C. iOS正常行为 → 走A分支
   blur后统一收起。诊断徽标显示当前命中分支，便于远程定位。 */
const kbOpen = ref(false)
const kbMode = ref('') // '' | 'shrink'(A) | 'top'(B)
const pageH = ref('')
let baseH = 0
let pollTimer = null
let topTimer = null

function measureH() {
  const vv = window.visualViewport
  return vv ? vv.height : window.innerHeight
}

function applyShrink(h) {
  if (kbMode.value !== 'shrink') scrollToBottom()
  kbMode.value = 'shrink'
  pageH.value = `${Math.round(h)}px`
}

function pollKb(ms) {
  clearInterval(pollTimer)
  const end = Date.now() + ms
  pollTimer = setInterval(() => {
    const h = measureH()
    if (baseH - h > 120) applyShrink(h)
    if (Date.now() >= end) clearInterval(pollTimer)
  }, 200)
}

const onInputFocus = () => {
  if (!baseH) baseH = Math.max(window.innerHeight, measureH())
  kbOpen.value = true // 立即进入键盘态：收导航间距+锁body滚动
  pollKb(3000)
  // 覆盖式键盘兜底：整个弹出期测不到视口压缩，就把输入框钉到顶部
  clearTimeout(topTimer)
  topTimer = setTimeout(() => {
    if (kbOpen.value && !pageH.value) kbMode.value = 'top'
  }, 1000)
}

const onInputBlur = () => {
  clearTimeout(topTimer)
  setTimeout(() => {
    kbOpen.value = false
    kbMode.value = ''
    pageH.value = ''
  }, 1200)
}

function bindKeyboard() {
  // focus/blur+轮询已覆盖事件路径，这里只负责初始化基准高度
  if (!baseH) baseH = Math.max(window.innerHeight, measureH())
}

onMounted(async () => {
  initUser()
  bindKeyboard()
  // 拉取动态配置的快捷提问
  try {
    const res = await getSettings()
    if (res.settings?.suggestions?.length) suggestions.value = res.settings.suggestions
  } catch {
    /* 保持默认 */
  }
})

onBeforeUnmount(() => {
  clearInterval(pollTimer)
  clearTimeout(topTimer)
})
</script>

<template>
  <div class="page ai-page" :style="pageH ? { height: pageH } : {}">
    <header class="page-header ai-header">
      <div class="header-top">
        <div>
          <h1 class="page-title">AI 智能查询</h1>
          <p class="page-subtitle">自然语言查询台账 · 统计与复盘</p>
        </div>
        <van-tag v-if="runtime.mockMode" plain type="warning" size="medium">演示模式</van-tag>
        <!-- 键盘诊断徽标（定位webview行为用，稳定后移除） -->
        <van-tag v-if="kbOpen" plain size="medium" class="kb-badge">v8·{{ kbMode || 'wait' }}</van-tag>
      </div>
    </header>

    <!-- 对话区 -->
    <div ref="listEl" class="chat-area">
      <div v-for="(msg, i) in messages" :key="i" class="msg-row" :class="msg.role">
        <img v-if="msg.role === 'ai'" :src="avatarImg" class="ai-avatar" alt="AI老谢" />
        <div class="bubble" :class="msg.role">
          <template v-if="msg.loading">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </template>
          <template v-else>{{ msg.text }}</template>
        </div>
      </div>

      <!-- 快捷提问 -->
      <div v-if="onlyWelcome() && !sending" class="suggest-wrap">
        <div class="suggest-title">试试这样问</div>
        <button v-for="s in suggestions" :key="s" class="suggest-chip" @click="send(s)">
          {{ s }}
        </button>
      </div>
    </div>

    <!-- 输入区 -->
    <footer class="chat-footer safe-bottom" :class="{ 'kb-open': kbOpen, 'kb-top': kbMode === 'top' }">
      <van-field
        v-model="input"
        class="chat-input"
        type="textarea"
        rows="1"
        autosize
        maxlength="200"
        placeholder="问点什么，如：本周我完成了哪些任务？"
        @focus="onInputFocus"
        @blur="onInputBlur"
        @keyup.enter.prevent="send()"
      />
      <van-button
        type="primary"
        round
        size="small"
        class="send-btn"
        :loading="sending"
        :disabled="!input.trim()"
        @click="send()"
      >
        发送
      </van-button>
    </footer>
  </div>
</template>

<style scoped>
.ai-page {
  display: flex;
  flex-direction: column;
  /* dvh 跟随真实可视高度（手机地址栏收起/键盘弹出时正确），老浏览器回退 100vh */
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

.ai-header {
  flex-shrink: 0;
}

.chat-area {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 14px 12px;
}

.msg-row {
  display: flex;
  margin-bottom: 12px;
}

.msg-row.user {
  justify-content: flex-end;
}

.ai-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  margin-right: 8px;
  box-shadow: 0 1px 4px rgba(31, 45, 61, 0.12);
}

.bubble {
  max-width: 78%;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble.ai {
  background: #fff;
  border-top-left-radius: 4px;
  box-shadow: 0 1px 4px rgba(31, 45, 61, 0.06);
}

.bubble.user {
  background: linear-gradient(135deg, #1677ff, #4d94ff);
  color: #fff;
  border-top-right-radius: 4px;
}

/* 加载动画 */
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 50%;
  background: var(--text-sub);
  animation: blink 1.2s infinite ease-in-out;
}

.dot:nth-child(2) {
  animation-delay: 0.2s;
}

.dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes blink {
  0%,
  80%,
  100% {
    opacity: 0.3;
  }
  40% {
    opacity: 1;
  }
}

/* 快捷提问 */
.suggest-wrap {
  padding: 4px 38px 12px;
}

.suggest-title {
  font-size: 12px;
  color: var(--text-sub);
  margin-bottom: 8px;
}

.suggest-chip {
  display: block;
  width: 100%;
  margin-bottom: 8px;
  padding: 9px 12px;
  border: 1px solid #e4e9f2;
  border-radius: 10px;
  background: #fff;
  color: var(--text-main);
  font-size: 13px;
  text-align: left;
}

.suggest-chip:active {
  background: #f2f7ff;
}

/* 输入区：稳贴底部 tabbar 上方 */
.chat-footer {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: calc(50px + env(safe-area-inset-bottom));
  background: var(--page-bg);
}

/* 键盘弹出：底部导航已隐藏（App.vue），去掉预留间距让输入框贴住键盘上沿 */
.chat-footer.kb-open {
  margin-bottom: 8px;
}

/* 覆盖式键盘兜底：视口不压缩时输入框钉到头部下方，键盘永远盖不住页面顶部 */
.chat-footer.kb-top {
  position: fixed;
  top: 76px;
  left: 12px;
  right: 12px;
  bottom: auto;
  margin: 0;
  z-index: 60;
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(22, 119, 255, 0.18);
}

.kb-badge {
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  background: #fff;
  border-radius: 10px;
  padding: 4px 0;
}

/* 输入文字/占位文案左右留白（覆盖上方 padding:0 的横向清零） */
.chat-input :deep(.van-field__control) {
  max-height: 72px;
  padding: 0 10px;
}

.send-btn {
  flex-shrink: 0;
  padding: 0 14px;
  height: 34px;
}
</style>
