import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { config } from './src/config.js'
import { getAI, getTable, getAsr } from './src/services/settings.js'
import loginRoutes from './src/routes/login.js'
import workRoutes from './src/routes/work.js'
import aiRoutes from './src/routes/ai.js'
import tasksRoutes from './src/routes/tasks.js'
import settingsRoutes from './src/routes/settings.js'
import projectsRoutes from './src/routes/projects.js'
import { auth } from './src/middleware/auth.js'
import { initFromTable, loadFromFile, seedDemoData } from './src/services/store.js'
import { startScheduler } from './src/services/pending-push.js'
import { fail, ok } from './src/utils/respond.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(cors())
app.use(express.json({ limit: '64kb' }))

// 健康检查
app.get('/api/health', (req, res) => {
  ok(res, {
    status: 'up',
    mode: config.dingtalkEnabled ? 'dingtalk' : 'demo',
    table: getTable().enabled,
    ai: getAI().enabled,
    time: new Date().toISOString(),
  })
})

// 登录无需鉴权，其余业务接口需登录
app.use('/api', loginRoutes)
app.use('/api', auth, workRoutes)
app.use('/api', auth, aiRoutes)
app.use('/api', auth, tasksRoutes)
app.use('/api', auth, settingsRoutes)
app.use('/api', auth, projectsRoutes)

// 本地一体化部署：托管前端构建产物（work-h5/dist），单端口访问
const DIST = path.resolve(__dirname, '../work-h5/dist')
if (fs.existsSync(DIST)) {
  app.use(
    express.static(DIST, {
      // 带哈希文件名的构建产物可永久缓存；HTML 每次回源校验，
      // 避免钉钉webview缓存旧index.html、引用已不存在的旧哈希JS导致白屏
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
        else if (filePath.includes(`${path.sep}assets${path.sep}`))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      },
    }),
  )
  // 非 /api 路径回退到前端入口（hash 路由，兼容直接访问）
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(DIST, 'index.html'))
  })
  console.log(`📦 已托管前端静态资源: ${DIST}`)
}

// 404（仅 API）
app.use('/api', (req, res) => fail(res, '接口不存在', 404))

// 统一异常出口
app.use((err, req, res, next) => {
  console.error('[server error]', err?.message || err)
  fail(res, err?.message || '服务内部异常', 500)
})

app.listen(config.port, () => {
  loadFromFile() // 回载本地落盘数据（重启不丢）
  seedDemoData() // 演示模式首次预置示例
  initFromTable() // 表格模式：全量回载钉钉AI表格
  startScheduler() // 补推队列：网络恢复后自动重推失败记录
  console.log(`✅ work-server 启动成功: http://localhost:${config.port}`)
  const ai = getAI()
  console.log(`   运行模式: ${config.dingtalkEnabled ? '钉钉正式模式' : '演示模式（未配置钉钉凭据）'}${getTable().enabled ? ' + AI表格同步' : ''}${ai.enabled ? ` + AI(${ai.provider === 'qwen' ? '通义千问' : '智谱GLM'}/${ai.model})` : '（AI查询为规则降级）'}${getAsr().enabled ? ' + 语音(讯飞)' : ''}`)
})
