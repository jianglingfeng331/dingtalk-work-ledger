<script setup>
import { nextTick, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
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

/* 键盘适配 v10：visualViewport 锚定（业界标准做法，放弃锁页高/锁滚动）
   输入框键盘态下改为 fixed，bottom = innerHeight - (vv.height + vv.offsetTop)。
   数学上：压缩式键盘（ICB缩小）该值=0，输入框贴 ICB 底=键盘上沿；
   平移式键盘（ICB不变、页面被下滚）该值仍=键盘上沿。两种 webview 通吃，
   且不锁定页面滚动，对话区照常滚动，不存在"输入框被锁在键盘下"的死角。
   兜底：若 1.2s 内视口完全无变化（纯覆盖式键盘），输入框钉到页面顶部。 */
const kbOpen = ref(false)
const kbMode = ref('') // '' | 'vv'(锚定) | 'top'(纯覆盖兜底)
const footerBottom = ref(0)
let baseH = 0
let pollTimer = null
let topTimer = null

function measureH() {
  const vv = window.visualViewport
  return vv ? vv.height : window.innerHeight
}

/** 依据可视视口实时计算输入框距 ICB 底部的偏移（=键盘高度） */
function anchorFooter() {
  const vv = window.visualViewport
  if (!vv) return
  footerBottom.value = Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)))
}

function pollKb(ms) {
  clearInterval(pollTimer)
  const end = Date.now() + ms
  pollTimer = setInterval(() => {
    anchorFooter()
    // 键盘态窗口必须保持scroll 0：原生聚焦会把窗口滚下去（平移式），
    // fixed输入框的锚定参照系随窗口滚动偏移，首次点击即失效的根源
    if (kbOpen.value && window.scrollY > 0) window.scrollTo(0, 0)
    // 视口压缩过（说明vv在正常上报）→ 正常锚定模式
    if (kbOpen.value && baseH - measureH() > 120) kbMode.value = 'vv'
    if (Date.now() >= end) clearInterval(pollTimer)
  }, 200)
}

/** 键盘态拦截窗口滚动：webview原生聚焦/回弹随时可能把窗口滚离0 */
function onWinScroll() {
  if (kbOpen.value && window.scrollY > 0) window.scrollTo(0, 0)
}

const onInputFocus = () => {
  if (!baseH) baseH = Math.max(window.innerHeight, measureH())
  kbOpen.value = true
  kbMode.value = 'vv'
  anchorFooter()
  window.scrollTo(0, 0) // 抢在原生聚焦滚动之前复位（首点关键）
  setTimeout(() => window.scrollTo(0, 0), 150) // 原生滚动发生在focus后，二次复位兜底
  scrollToBottom()
  pollKb(3000)
  // 纯覆盖式键盘兜底：视口毫无变化则钉顶
  clearTimeout(topTimer)
  topTimer = setTimeout(() => {
    if (kbOpen.value && baseH - measureH() <= 120) kbMode.value = 'top'
  }, 1200)
}

const onInputBlur = () => {
  clearTimeout(topTimer)
  setTimeout(() => {
    kbOpen.value = false
    kbMode.value = ''
    footerBottom.value = 0
    window.scrollTo(0, 0) // 平移式键盘收起后窗口可能停在滚动偏移上，复位
  }, 300)
}

function bindKeyboard() {
  // vv 的 resize/scroll 事件期间持续锚定（scroll 在平移式键盘的原生滚动中就会触发）
  window.visualViewport?.addEventListener('resize', anchorFooter)
  window.visualViewport?.addEventListener('scroll', anchorFooter)
  window.addEventListener('scroll', onWinScroll, { passive: true })
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

onDeactivated(() => {
  // keep-alive 切走页面：键盘态立即复位，避免fixed输入框残留
  clearInterval(pollTimer)
  clearTimeout(topTimer)
  kbOpen.value = false
  kbMode.value = ''
  footerBottom.value = 0
})

onBeforeUnmount(() => {
  clearInterval(pollTimer)
  clearTimeout(topTimer)
  window.visualViewport?.removeEventListener('resize', anchorFooter)
  window.visualViewport?.removeEventListener('scroll', anchorFooter)
  window.removeEventListener('scroll', onWinScroll)
})
</script>

<template>
  <div class="page ai-page">
    <header class="page-header ai-header">
      <div class="header-top">
        <div>
          <h1 class="page-title">AI 智能查询</h1>
          <p class="page-subtitle">自然语言查询台账 · 统计与复盘</p>
        </div>
        <van-tag v-if="runtime.mockMode" plain type="warning" size="medium">演示模式</van-tag>
        <!-- 键盘诊断徽标（定位webview行为用，稳定后移除）：显示锚定模式与实时偏移 -->
        <van-tag v-if="kbOpen" plain size="medium" class="kb-badge">v10·{{ kbMode }}·{{ footerBottom }}</van-tag>
      </div>
    </header>

    <!-- 对话区 -->
    <div ref="listEl" class="chat-area" :class="{ 'kb-pad': kbOpen }">
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

    <!-- 输入区：键盘态改为 fixed 并锚定到键盘上沿（visualViewport 实时计算） -->
    <footer
      class="chat-footer safe-bottom"
      :class="{ 'kb-fixed': kbOpen && kbMode !== 'top', 'kb-top': kbOpen && kbMode === 'top' }"
      :style="kbOpen && kbMode !== 'top' ? { bottom: `${footerBottom}px` } : {}"
    >
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

/* 键盘态：输入框脱离文档流，fixed 锚定键盘上沿（bottom 由 JS 按 visualViewport 实时计算） */
.chat-footer.kb-fixed {
  position: fixed;
  left: 0;
  right: 0;
  margin-bottom: 0;
  z-index: 100;
  background: var(--page-bg);
  box-shadow: 0 -2px 8px rgba(31, 45, 61, 0.06);
}

/* 纯覆盖式键盘兜底：视口不缩时输入框钉到头部下方，键盘永远盖不住页面顶部 */
.chat-footer.kb-top {
  position: fixed;
  top: 76px;
  left: 12px;
  right: 12px;
  bottom: auto;
  margin: 0;
  z-index: 100;
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(22, 119, 255, 0.18);
}

/* 键盘态对话区底部让位，最后一条消息不被 fixed 输入框盖住 */
.chat-area {
  transition: padding-bottom 0.15s;
}
.chat-area.kb-pad {
  padding-bottom: 96px;
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
