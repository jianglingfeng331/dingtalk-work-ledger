import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from '@vant/auto-import-resolver'
import pxToViewport from 'postcss-px-to-viewport-8-plugin'

export default defineConfig({
  plugins: [
    vue(),
    // Vant 组件按需自动引入（含样式）
    Components({ resolvers: [VantResolver()] }),
  ],
  build: {
    // 不清空旧构建产物：钉钉webview可能缓存旧版index.html，其引用的旧哈希JS必须继续存在，
    // 否则旧缓存用户首进白屏。部署到服务器时同样勿删 assets 下的旧文件（增量覆盖）。
    emptyOutDir: false,
  },
  css: {
    postcss: {
      plugins: [
        // 移动端适配：设计稿 375px，px 自动转 vw
        pxToViewport({
          viewportWidth: 375,
          unitPrecision: 5,
          viewportUnit: 'vw',
          selectorBlackList: ['.ignore-vw'],
          minPixelValue: 1,
          mediaQuery: false,
          // 桌面端页面/组件不转 vw，保持 px（电脑上 1vw 过大会把整页放大数倍）
          exclude: [/QuickFillPage/, /WebSettingsPage/, /AiAssistant/],
        }),
      ],
    },
  },
  server: {
    host: '0.0.0.0', // 手机同局域网可访问
    port: 5173,
    proxy: {
      // 阶段二后端就绪后，本地开发自动代理到 Node 服务
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
