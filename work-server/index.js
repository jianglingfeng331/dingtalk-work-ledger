import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import compression from 'compression'
import { config } from './src/config.js'
import { getAI, getTable, getAsr } from './src/services/settings.js'
import loginRoutes, { jsapiRouter } from './src/routes/login.js'
import desktopPairRoutes from './src/routes/desktop-pair.js'
import workRoutes from './src/routes/work.js'
import aiRoutes from './src/routes/ai.js'
import tasksRoutes from './src/routes/tasks.js'
import directiveRoutes from './src/routes/directive.js'
import settingsRoutes from './src/routes/settings.js'
import projectsRoutes from './src/routes/projects.js'
import { auth } from './src/middleware/auth.js'
import { projectGuard } from './src/middleware/project-guard.js'
import mcpRoutes from './src/routes/mcp-server.js'
import { initFromTable, loadFromFile, seedDemoData } from './src/services/store.js'
import { startScheduler } from './src/services/pending-push.js'
import { startReconcileScheduler } from './src/services/directive.js'
import { fail, ok } from './src/utils/respond.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

/* CORS 收敛：生产为同源部署（页面与 /api 同域），仅放行自身来源与本地开发调试来源；
   其他跨域浏览器请求不返回 CORS 头（被浏览器拦截），非浏览器调用（curl/服务端）不受影响 */
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']
const EXTRA_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin || ''
  const host = req.headers.host || ''
  let sameHost = false
  try {
    sameHost = new URL(origin).host === host
  } catch {
    /* 非法 origin */
  }
  if (origin && (DEV_ORIGINS.includes(origin) || EXTRA_ORIGINS.includes(origin) || sameHost)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-project-id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json({ limit: '64kb' }))
// gzip 压缩：JS/CSS/JSON 体积降 60-70%（首屏 ~280KB → ~90KB），弱网下显著缩短首次白屏时间
app.use(compression({ threshold: 1024 }))

// 健康检查（精简：不暴露运行形态细节，完整状态仅打印在服务端启动日志）
app.get('/api/health', (req, res) => {
  ok(res, { status: 'up', time: new Date().toISOString() })
})

// 前端版本（入口JS文件名，发版即变化）：随 /api 响应头 X-App-Entry 下发。
// 钉钉webview可能长期使用缓存的旧版HTML不回源（旧资源保留在服务器→旧版可运行但不会更新），
// 前端对比本页实际加载的入口与此值，不一致即自动换URL刷新升级。
const FRONTEND_DIST = path.resolve(__dirname, '../work-h5/dist')
let frontendEntry = ''
try {
  frontendEntry =
    (fs.readFileSync(path.join(FRONTEND_DIST, 'index.html'), 'utf8').match(/src="(\/assets\/index-[^"]+\.js)"/) ||
      [])[1] || ''
} catch {
  /* dist 尚未部署时忽略 */
}
app.use('/api', (req, res, next) => {
  if (frontendEntry) res.setHeader('X-App-Entry', frontendEntry)
  next()
})

// 登录免鉴权；jsapi-sign 需登录（录音等客户端能力均在登录后使用）
app.use('/api', loginRoutes)
// 桌面端扫码配对：发起/轮询免鉴权（pairId 为一次性随机凭据），授权页查询/确认在路由内挂 auth
app.use('/api', desktopPairRoutes)
app.use('/api', auth, jsapiRouter)
// 项目发现与全局配置接口：必须挂在 projectGuard 之前 ——
// app.use('/api', auth, projectGuard, xxx) 的 guard 对所有 /api 前缀请求生效（不管最终由哪个router处理），
// 若这些接口排在 guard 之后，清缓存/新用户无项目ID时连项目列表都拿不到 → 死锁（项目ID只能从列表获取）
app.use('/api', auth, settingsRoutes)
app.use('/api', auth, projectsRoutes)
// 业务接口：登录 + 项目成员校验（防 x-project-id 跨项目越权）
app.use('/api', auth, projectGuard, workRoutes)
app.use('/api', auth, projectGuard, aiRoutes)
app.use('/api', auth, projectGuard, tasksRoutes)
app.use('/api', auth, projectGuard, directiveRoutes)

// MCP 服务（Streamable HTTP，同进程挂载 /mcp；内部自带鉴权，需在 SPA 回退之前注册）
app.use('/mcp', mcpRoutes)

// 本地一体化部署：托管前端构建产物（work-h5/dist），单端口访问
const DIST = path.resolve(__dirname, '../work-h5/dist')
if (fs.existsSync(DIST)) {
  // 静态资源访问日志：排查钉钉webview加载了哪个版本的JS（定位缓存/发版问题）
  app.use('/assets', (req, res, next) => {
    if (/\.(js|css)$/.test(req.path)) {
      console.log(`[static] ${new Date().toLocaleTimeString('zh-CN')} ${req.path} <- ${req.ip}`)
    }
    next()
  })
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
    // 静态资源缺失（钉钉webview缓存旧HTML、引用已删除的旧哈希文件）：明确404，
    // 不能把 index.html 当 JS 返回（MIME不符只会让模块加载报错更难排查）
    if (req.path.startsWith('/assets/')) return res.status(404).end()
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(DIST, 'index.html'))
  })
  console.log(`📦 已托管前端静态资源: ${DIST}`)
}

// 404（仅 API）
app.use('/api', (req, res) => fail(res, '接口不存在', 404))

// 统一异常出口：按错误类型透传 HTTP 状态码（body-parser 超限=413，其余带 status 属性的用其值，兜底 500）
app.use((err, req, res, next) => {
  console.error(`[server error] ${req.method} ${req.originalUrl} user=${req.user?.userId || '-'}:`, err?.message || err)
  const status = err?.type === 'entity.too.large' ? 413 : Number.isInteger(err?.status) && err.status >= 400 ? err.status : 500
  res.status(status).json({ code: status, data: null, message: err?.message || '服务内部异常' })
})

app.listen(config.port, () => {
  loadFromFile() // 回载本地落盘数据（重启不丢）
  seedDemoData() // 演示模式首次预置示例
  initFromTable() // 表格模式：全量回载钉钉AI表格
  startScheduler() // 补推队列：网络恢复后自动重推失败记录
  startReconcileScheduler() // 领导指令对账：指令状态与任务表保持一致
  console.log(`✅ work-server 启动成功: http://localhost:${config.port}`)
  const ai = getAI()
  console.log(`   运行模式: ${config.dingtalkEnabled ? '钉钉正式模式' : '演示模式（未配置钉钉凭据）'}${getTable().enabled ? ' + AI表格同步' : ''}${ai.enabled ? ` + AI(${ai.provider === 'qwen' ? '通义千问' : '智谱GLM'}/${ai.model})` : '（AI查询为规则降级）'}${getAsr().enabled ? ' + 语音(讯飞)' : ''}`)
})
