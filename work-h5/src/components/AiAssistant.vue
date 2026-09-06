<script setup>
import { nextTick, onMounted, reactive, ref } from 'vue'
import { aiQuery, getSettings, runtime } from '../api'
import mascotImg from '../assets/ai-assistant.png'
import avatarImg from '../assets/ai-avatar.png'

/**
 * web 端 AI 助手（桌面页悬浮人物）
 * 技术方案与移动端 AI 查询页完全一致：
 * - aiQuery(question)：后端 MCP 实时拉取台账数据 + 智谱 LLM 统计/复盘
 * - 快捷提问来自系统设置 getSettings().settings.suggestions
 * 交互：点击右下角「老谢」人物 → 弹出聊天面板，文字提问、流式加载动画
 */
const open = ref(false)
const hasOpened = ref(false)
const messages = ref([
  {
    role: 'ai',
    text: '你好，我是 AI老谢。可以直接问我工作数据，例如「本周我完成了哪些任务？」，我会基于团队台账给你统计与复盘。',
  },
])
const input = ref('')
const sending = ref(false)
const listEl = ref(null)
const inputEl = ref(null)

// 快捷提问：来自系统动态配置（设置页可改）
const suggestions = ref(['本周我完成了哪些任务？', '我有哪些未完成的任务？', '团队本周工作汇总'])

const onlyWelcome = () => messages.value.length === 1

function toggle() {
  open.value = !open.value
  if (open.value) {
    hasOpened.value = true
    nextTick(() => {
      inputEl.value?.focus()
      scrollToBottom()
    })
  }
}

/** 发起 AI 查询（流式：模型边生成边逐字显示，首字约1秒内出现） */
async function send(q) {
  const question = (q ?? input.value).trim()
  if (!question || sending.value) return
  input.value = ''
  messages.value.push({ role: 'user', text: question })
  // 必须用 reactive 包装：直接 mutate push 进数组的原始对象不会触发 Vue 渲染
  const aiMsg = reactive({ role: 'ai', text: '', loading: true })
  messages.value.push(aiMsg)
  sending.value = true
  scrollToBottom()
  // 兜底清除 LLM 偶发输出的 Markdown 星号/井号（与后端最终清洗一致）
  const clean = (s) => s.replace(/\*\*?/g, '').replace(/^#{1,6}\s*/gm, '')
  try {
    const answer = await aiQuery(question, {
      onToken: (_delta, full) => {
        aiMsg.loading = false
        aiMsg.text = clean(full)
        scrollToBottom()
      },
    })
    aiMsg.text = clean(answer || aiMsg.text)
    if (!aiMsg.text.trim()) {
      aiMsg.text = 'AI 没有返回内容，请稍后重试'
    }
  } catch (err) {
    const tip = '查询失败：' + (err?.message || '请稍后重试')
    aiMsg.text = aiMsg.text ? `${aiMsg.text}\n\n${tip}` : tip
  } finally {
    aiMsg.loading = false
    sending.value = false
    nextTick(() => inputEl.value?.focus())
    scrollToBottom()
  }
}

function onKeydown(e) {
  // Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function scrollToBottom() {
  nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

onMounted(async () => {
  try {
    const res = await getSettings()
    if (res.settings?.suggestions?.length) suggestions.value = res.settings.suggestions
  } catch {
    /* 保持默认快捷提问 */
  }
})
</script>

<template>
  <div class="ai-assistant">
    <!-- 聊天面板 -->
    <Transition name="chat-pop">
      <section v-if="open" class="chat-card" role="dialog" aria-label="AI 助手">
        <header class="chat-head">
          <img :src="avatarImg" class="head-avatar" alt="AI老谢" />
          <div class="head-text">
            <span class="head-name">
              AI 助手 · 老谢
              <em v-if="runtime.mockMode" class="mock-tag">演示</em>
            </span>
            <span class="head-sub">台账数据统计与复盘</span>
          </div>
          <button type="button" class="close-btn" aria-label="关闭" @click="toggle">
            <svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div ref="listEl" class="chat-body">
          <div v-for="(msg, i) in messages" :key="i" class="msg-row" :class="msg.role">
            <img v-if="msg.role === 'ai'" :src="avatarImg" class="msg-avatar" alt="AI老谢" />
            <div class="bubble" :class="msg.role">
              <template v-if="msg.loading">
                <span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
                <span class="loading-hint">正在统计台账数据，请稍候…</span>
              </template>
              <template v-else>{{ msg.text }}</template>
            </div>
          </div>

          <!-- 快捷提问（仅欢迎语时展示） -->
          <div v-if="onlyWelcome() && !sending" class="suggest-wrap">
            <button v-for="s in suggestions" :key="s" type="button" class="suggest-chip" @click="send(s)">
              {{ s }}
            </button>
          </div>
        </div>

        <footer class="chat-foot">
          <textarea
            ref="inputEl"
            v-model="input"
            class="chat-input"
            rows="1"
            maxlength="200"
            placeholder="问点什么，如：本周我完成了哪些任务？"
            @keydown="onKeydown"
          ></textarea>
          <button
            type="button"
            class="send-btn"
            :disabled="!input.trim() || sending"
            aria-label="发送"
            @click="send()"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M1.5 8L14.5 2l-3 12.5-3.2-4.2L1.5 8z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </footer>
      </section>
    </Transition>

    <!-- 首次引导气泡 -->
    <Transition name="tip-fade">
      <button v-if="!hasOpened" type="button" class="greet-tip" @click="toggle">
        你好，点我可以查询台账数据
        <span class="tip-tail" aria-hidden="true"></span>
      </button>
    </Transition>

    <!-- 悬浮人物 -->
    <button type="button" class="mascot-launcher" :class="{ waving: open }" aria-label="打开AI助手" @click="toggle">
      <img :src="mascotImg" class="mascot-img" alt="AI老谢" draggable="false" />
      <span class="mascot-ring" aria-hidden="true"></span>
    </button>
  </div>
</template>

<style scoped>
/* 本组件被 vite 的 px→vw 适配排除，样式保持 px（桌面悬浮助手） */
.ai-assistant {
  position: fixed;
  right: 26px;
  bottom: 14px;
  z-index: 50;
}

/* ============ 悬浮人物 ============ */
.mascot-launcher {
  position: relative;
  display: block;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  width: 108px;
  height: 244px;
}

.mascot-img {
  width: 108px;
  height: auto;
  display: block;
  filter: drop-shadow(0 10px 16px rgba(23, 43, 77, 0.22));
  transform-origin: bottom center;
  animation: mascot-idle 4.2s ease-in-out infinite;
  transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.3, 1);
}

.mascot-launcher:hover .mascot-img {
  transform: translateY(-5px) scale(1.04);
  animation: none;
}

.mascot-launcher:active .mascot-img {
  transform: translateY(-1px) scale(0.98);
}

/* 人物脚下光圈 */
.mascot-ring {
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 84px;
  height: 16px;
  transform: translateX(-50%);
  border-radius: 50%;
  background: radial-gradient(ellipse at center, rgba(23, 43, 77, 0.28), transparent 68%);
  z-index: -1;
}

@keyframes mascot-idle {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

/* 面板打开时人物轻微“致意” */
.mascot-launcher.waving .mascot-img {
  animation: mascot-wave 0.6s ease;
}

@keyframes mascot-wave {
  0% {
    transform: rotate(0);
  }
  30% {
    transform: rotate(-3deg) translateY(-3px);
  }
  60% {
    transform: rotate(2deg);
  }
  100% {
    transform: rotate(0);
  }
}

/* ============ 首次引导气泡 ============ */
.greet-tip {
  position: absolute;
  right: 118px;
  bottom: 178px;
  padding: 10px 16px;
  border: 1px solid #e3e8ef;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 8px 24px -8px rgba(23, 43, 77, 0.25);
  font-size: 13px;
  font-weight: 550;
  color: #344054;
  white-space: nowrap;
  cursor: pointer;
  font-family: inherit;
  animation: tip-breathe 2.4s ease-in-out infinite;
}

.tip-tail {
  position: absolute;
  right: -7px;
  top: 50%;
  width: 12px;
  height: 12px;
  background: #fff;
  border-top: 1px solid #e3e8ef;
  border-right: 1px solid #e3e8ef;
  transform: translateY(-50%) rotate(45deg);
}

@keyframes tip-breathe {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-4px);
  }
}

.tip-fade-enter-active,
.tip-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.tip-fade-enter-from,
.tip-fade-leave-to {
  opacity: 0;
  transform: translateX(10px);
}

/* ============ 聊天面板 ============ */
.chat-card {
  position: absolute;
  right: 0;
  bottom: 250px;
  width: 402px;
  height: min(600px, calc(100dvh - 300px));
  min-height: 380px;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(23, 43, 77, 0.08);
  border-radius: 16px;
  box-shadow:
    0 2px 6px rgba(23, 43, 77, 0.06),
    0 28px 64px -20px rgba(23, 43, 77, 0.38);
  overflow: hidden;
  transform-origin: bottom right;
}

.chat-pop-enter-active {
  transition: opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1), transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.chat-pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.chat-pop-enter-from,
.chat-pop-leave-to {
  opacity: 0;
  transform: translateY(14px) scale(0.94);
}

/* 头部 */
.chat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  border-bottom: 1px solid #eef0f4;
  background: linear-gradient(180deg, rgba(22, 119, 255, 0.05), rgba(22, 119, 255, 0));
  flex-shrink: 0;
}

.head-avatar {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  object-fit: cover;
  box-shadow: 0 2px 6px rgba(22, 119, 255, 0.3);
}

.head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.head-name {
  font-size: 14px;
  font-weight: 650;
  color: #1d2939;
  display: flex;
  align-items: center;
  gap: 6px;
}

.mock-tag {
  font-style: normal;
  font-size: 10px;
  color: #b45309;
  background: rgba(217, 119, 6, 0.1);
  padding: 1px 6px;
  border-radius: 999px;
}

.head-sub {
  font-size: 11.5px;
  color: #98a2b3;
}

.close-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #98a2b3;
  cursor: pointer;
  transition: all 0.15s ease;
}

.close-btn:hover {
  background: #f2f4f7;
  color: #475467;
}

.close-btn:active {
  transform: scale(0.92);
}

/* 消息区 */
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 14px 8px;
  background:
    radial-gradient(420px 220px at 100% 0%, rgba(22, 119, 255, 0.04), transparent 60%),
    #f8f9fb;
}

.msg-row {
  display: flex;
  margin-bottom: 14px;
}

.msg-row.user {
  justify-content: flex-end;
}

.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  object-fit: cover;
  flex-shrink: 0;
  margin-right: 8px;
  box-shadow: 0 1px 4px rgba(31, 45, 61, 0.12);
}

.bubble {
  max-width: 78%;
  padding: 10px 13px;
  border-radius: 13px;
  font-size: 13.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble.ai {
  background: #fff;
  color: #232b38;
  border-top-left-radius: 4px;
  box-shadow: 0 1px 3px rgba(23, 43, 77, 0.07);
}

.bubble.user {
  background: #1677ff;
  color: #fff;
  border-top-right-radius: 4px;
  box-shadow: 0 2px 8px rgba(22, 119, 255, 0.32);
}

/* 加载三点 */
.dots {
  display: inline-flex;
  align-items: center;
}

.loading-hint {
  display: block;
  margin-top: 7px;
  font-size: 11.5px;
  line-height: 1.3;
  color: #98a2b3;
  white-space: nowrap;
}

.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 50%;
  background: #98a2b3;
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
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 0 8px 40px;
}

.suggest-chip {
  padding: 8px 13px;
  border: 1px solid #e3e8ef;
  border-radius: 999px;
  background: #fff;
  color: #475467;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.16s ease;
}

.suggest-chip:hover {
  border-color: #1677ff;
  color: #1677ff;
  background: rgba(22, 119, 255, 0.05);
  transform: translateY(-1px);
}

.suggest-chip:active {
  transform: scale(0.97);
}

/* 输入区 */
.chat-foot {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 1px solid #eef0f4;
  background: #fff;
}

.chat-input {
  flex: 1;
  max-height: 84px;
  padding: 9px 12px;
  border: 1px solid #dde2ea;
  border-radius: 10px;
  background: #f8f9fb;
  font-size: 13.5px;
  font-family: inherit;
  line-height: 1.5;
  color: #232b38;
  resize: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}

.chat-input:hover {
  border-color: #b9c2d0;
}

.chat-input:focus {
  outline: none;
  border-color: #1677ff;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(22, 119, 255, 0.14);
}

.send-btn {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 10px;
  background: #1677ff;
  color: #fff;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(22, 119, 255, 0.4);
  transition: all 0.18s cubic-bezier(0.2, 0.8, 0.3, 1);
}

.send-btn:not(:disabled):hover {
  background: #2b82ff;
  transform: translateY(-1px);
  box-shadow: 0 5px 14px -3px rgba(22, 119, 255, 0.55);
}

.send-btn:active:not(:disabled) {
  transform: scale(0.94);
}

.send-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 键盘可达性 */
:where(button, textarea):focus-visible {
  outline: 2px solid rgba(22, 119, 255, 0.55);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .mascot-img,
  .greet-tip {
    animation: none;
  }
}

/* 矮屏兜底 */
@media (max-height: 640px) {
  .chat-card {
    bottom: 240px;
    min-height: 300px;
  }
}
</style>
