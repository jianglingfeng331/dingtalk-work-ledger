<script setup>
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import { initUser } from './utils/user'

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

    <van-tabbar v-show="!kbOpen" route safe-area-inset-bottom class="app-tabbar">
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

/* 键盘弹起（body.kb-open）：导航已隐藏，输入区下 margin 同步收掉，贴住键盘 */
body.kb-open .chat-footer {
  margin-bottom: 8px !important;
}

/* 键盘弹起时锁定页面滚动：页面高度已锁到可视区，若外层仍可滚
   （app-shell min-height:100vh 在键盘不缩vh的webview下偏大），
   拖动会把贴在键盘上的输入框拖走 */
body.kb-open {
  overflow: hidden;
  overscroll-behavior: none;
}
</style>

<style scoped>
.app-shell {
  min-height: 100vh;
}
</style>
