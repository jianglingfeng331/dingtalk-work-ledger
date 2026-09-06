import { createApp } from 'vue'
import '@vant/touch-emulator' // 桌面浏览器调试时支持移动端点击事件
import './style.css'
import App from './App.vue'
import router from './router'

const app = createApp(App).use(router) // install 时初始导航即开始（拉取首屏组件）

/* 首进白屏修复：
 * 1) 挂载必须等初始路由就绪。此前挂载即销毁 index.html 的启动 loading，而路由组件
 *    是懒加载 chunk（首访需网络下载），期间 router-view 为空 → 内容区白屏；
 *    chunk 请求卡住/失败时永久空白，只能手动刷新。等待期间启动 loading 持续兜底。
 * 2) 懒加载 chunk 拉取失败（发版后旧哈希文件被替换等）自动换URL刷新一次自愈
 *    （index.html 为 no-cache，刷新即拿到新版引用）；sessionStorage 防刷新循环。
 *    换URL而非 reload()：部分钉钉webview对 reload 仍命中本地缓存。 */
function bustReload() {
  const search = location.search.replace(/([?&])_r=\d+&?/, '$1').replace(/[?&]$/, '')
  location.replace(location.pathname + search + (search ? '&' : '?') + '_r=' + Date.now() + location.hash)
}

router.onError((err) => {
  const msg = String(err?.message || err)
  if (/dynamically imported module|loading chunk|chunk failed|Importing a module script failed/i.test(msg)) {
    try {
      if (!sessionStorage.getItem('work_chunk_reloaded')) {
        sessionStorage.setItem('work_chunk_reloaded', '1')
        bustReload()
      }
    } catch {
      /* ignore */
    }
  }
})

router
  .isReady()
  .catch(() => {})
  .then(() => {
    app.mount('#app')
    // 启动诊断（设置页-运行状态可见）：排查"白屏时JS到底有没有跑"的关键证据
    try {
      localStorage.setItem('work_last_mount', new Date().toLocaleString())
    } catch {
      /* ignore */
    }
  })
