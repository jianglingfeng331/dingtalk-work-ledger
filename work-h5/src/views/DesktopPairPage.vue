<script setup>
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { showFailToast, showSuccessToast } from 'vant'
import { confirmPairApi, getPairStatusApi } from '../api'
import { initUser, userStore } from '../utils/user'
import { isDingTalkEnv } from '../utils/dingtalk'

const route = useRoute()
const pairId = String(route.query.pair || '')

// loading：页面初始化（免登 + 查配对状态）
const loading = ref(true)
const confirming = ref(false)
// state: invalid(链接无效) | outside(非钉钉环境) | pending(待授权) | done(已授权) | expired(已过期)
const state = ref('pending')
const userName = ref('')

onMounted(async () => {
  if (!pairId) {
    state.value = 'invalid'
    loading.value = false
    return
  }
  if (!isDingTalkEnv()) {
    state.value = 'outside'
    loading.value = false
    return
  }
  try {
    // 确保钉钉免登完成（身份即当前扫码人）
    await initUser()
    userName.value = userStore.name || ''
    const res = await getPairStatusApi(pairId)
    state.value = res?.status === 'pending' ? 'pending' : res?.status === 'confirmed' ? 'done' : 'expired'
  } catch (err) {
    // 410/404：配对过期或不存在
    state.value = /过期|不存在|不可用/.test(err?.message || '') ? 'expired' : 'invalid'
  } finally {
    loading.value = false
  }
})

async function onConfirm() {
  if (confirming.value) return
  confirming.value = true
  try {
    await confirmPairApi(pairId)
    state.value = 'done'
    showSuccessToast('授权成功')
  } catch (err) {
    showFailToast(err?.message || '授权失败，请重试')
    if (/过期|不存在|不可用/.test(err?.message || '')) state.value = 'expired'
  } finally {
    confirming.value = false
  }
}
</script>

<template>
  <div class="pair-page">
    <div class="pair-card">
      <div v-if="loading" class="pair-body">
        <van-loading size="28px">正在准备…</van-loading>
      </div>

      <div v-else-if="state === 'outside'" class="pair-body">
        <div class="pair-icon"><img src="/favicon.svg" alt="秒建功" /></div>
        <h2>请在钉钉中打开</h2>
        <p class="pair-desc">此页面用于给电脑上的「秒建功」桌面端授权登录，请用<b>钉钉 App 扫描电脑上的二维码</b>打开本页。</p>
      </div>

      <div v-else-if="state === 'invalid'" class="pair-body">
        <div class="pair-icon"><img src="/favicon.svg" alt="秒建功" /></div>
        <h2>链接无效</h2>
        <p class="pair-desc">未检测到配对信息，请回到电脑端「秒建功」重新获取二维码。</p>
      </div>

      <div v-else-if="state === 'expired'" class="pair-body">
        <div class="pair-icon"><img src="/favicon.svg" alt="秒建功" /></div>
        <h2>二维码已过期</h2>
        <p class="pair-desc">配对二维码 5 分钟内有效，请回到电脑端「秒建功」点击刷新二维码后重新扫码。</p>
      </div>

      <div v-else-if="state === 'pending'" class="pair-body">
        <div class="pair-icon"><img src="/favicon.svg" alt="秒建功" /></div>
        <h2>桌面端登录授权</h2>
        <p class="pair-desc">
          授权后，电脑上的「秒建功」桌面端将以你的钉钉身份登录：
        </p>
        <div class="pair-user">{{ userName || '当前钉钉用户' }}</div>
        <van-button type="primary" block round :loading="confirming" loading-text="授权中…" @click="onConfirm">
          确认授权
        </van-button>
        <p class="pair-tip">仅在你本人扫码、且需要登录桌面端时确认</p>
      </div>

      <div v-else-if="state === 'done'" class="pair-body">
        <div class="pair-icon"><img src="/favicon.svg" alt="秒建功" /></div>
        <h2>授权成功</h2>
        <p class="pair-desc">「秒建功」桌面端已完成登录，请回到电脑端查看。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pair-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 20px;
  background: #f5f7fa;
  box-sizing: border-box;
}
.pair-card {
  width: 100%;
  max-width: 380px;
  background: #fff;
  border-radius: 16px;
  padding: 32px 24px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
}
.pair-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.pair-icon {
  width: 72px;
  height: 72px;
  margin-bottom: 16px;
  border-radius: 18px;
  background: #f2f3f5;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pair-icon img {
  width: 40px;
  height: 40px;
  display: block;
}
.pair-body h2 {
  font-size: 19px;
  margin: 0 0 10px;
  color: #1f2329;
}
.pair-desc {
  font-size: 14px;
  line-height: 1.7;
  color: #646a73;
  margin: 0 0 18px;
}
.pair-user {
  font-size: 17px;
  font-weight: 600;
  color: #1989fa;
  background: #ecf5ff;
  border-radius: 10px;
  padding: 10px 18px;
  margin-bottom: 22px;
  max-width: 100%;
  word-break: break-all;
}
.pair-tip {
  margin: 14px 0 0;
  font-size: 12px;
  color: #9aa0a8;
}
</style>
