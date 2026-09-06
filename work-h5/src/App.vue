<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { initUser } from './utils/user'
import AiAssistant from './components/AiAssistant.vue'

const route = useRoute()
// 桌面端页面（/quick 快速填写、/settings-web 网页设置、/desktop-pair 扫码授权）不显示移动端底部导航
const isDesktopPage = computed(() => ['quick', 'settingsWeb', 'desktopPair'].includes(route.name))
// AI 悬浮卡通人物仅 /quick、/settings-web 展示（扫码授权页不出现角色形象）
const showAssistant = computed(() => ['quick', 'settingsWeb'].includes(route.name))
// body 打标：桌面页下 Toast/Dialog 等渲染到 body 的 vant 组件用固定 px（覆盖样式在 index.html）
watchEffect(() => document.body.classList.toggle('quick-desktop', isDesktopPage.value))

// 键盘弹起检测：可视高度较初始值骤降120px以上视为键盘弹出
// （钉钉安卓webview会压缩页面把fixed的tabbar顶到键盘上方，故弹起时暂隐导航，收起恢复）
const kbOpen = ref(false)
let baseH = 0
const checkKb = () => {
  const vv = window.visualViewport
  const h = vv ? vv.height : window.innerHeight
  if (!baseH) baseH = Math.max(window.innerHeight, h)
  kbOpen.value = baseH - h > 120
}
watchEffect(() => document.body.classList.toggle('kb-open', kbOpen.value))

// 启动时初始化用户身份（钉钉免登 / 后端演示登录 / 本地兜底）
onMounted(() => {
  initUser()
  window.visualViewport?.addEventListener('resize', checkKb)
  window.addEventListener('resize', checkKb)
  checkKb()
})

onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener('resize', checkKb)
  window.removeEventListener('resize', checkKb)
})
</script>

<template>
  <div class="app-shell">
    <router-view v-slot="{ Component }">
      <keep-alive>
        <component :is="Component" />
      </keep-alive>
    </router-view>

    <van-tabbar v-show="!kbOpen && !isDesktopPage" route safe-area-inset-bottom class="app-tabbar">
      <van-tabbar-item replace to="/">
        <span>工作记录</span>
        <template #icon>
          <van-icon name="edit" />
        </template>
      </van-tabbar-item>
      <van-tabbar-item replace to="/tasks">
        <span>任务</span>
        <template #icon>
          <van-icon name="todo-list-o" />
        </template>
      </van-tabbar-item>
      <van-tabbar-item replace to="/ai">
        <span>AI 查询</span>
        <template #icon>
          <van-icon name="chat-o" />
        </template>
      </van-tabbar-item>
      <van-tabbar-item replace to="/settings">
        <span>设置</span>
        <template #icon>
          <van-icon name="setting-o" />
        </template>
      </van-tabbar-item>
    </van-tabbar>

    <!-- web 桌面页：右下角 AI 助手悬浮人物（仅 /quick、/settings-web，扫码授权页不显示） -->
    <AiAssistant v-if="showAssistant" />
  </div>
</template>

<style>
/* 修复：切换页签时图标宽度变化导致的显示不完整，统一固定宽度居中 */
.app-tabbar .van-tabbar-item__icon {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
}

.app-tabbar .van-tabbar-item__icon .van-icon {
  font-size: 20px;
  line-height: 1;
  display: block;
}

/* body.kb-open 仅作标记（tabbar 隐藏由 kbOpen ref 驱动 v-show）。
   v10 起 AI 查询页用 visualViewport 锚定 fixed 输入框，无需锁定 body 滚动。 */
</style>

<style scoped>
.app-shell {
  min-height: 100vh;
}
</style>
