import { createApp } from 'vue'
import '@vant/touch-emulator' // 桌面浏览器调试时支持移动端点击事件
import './style.css'
import App from './App.vue'
import router from './router'

createApp(App).use(router).mount('#app')
