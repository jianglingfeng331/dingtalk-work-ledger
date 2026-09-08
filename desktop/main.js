// 秒建功 · 主进程：透明置顶桌宠窗口 + 原生右键菜单 + 窗口拖动 + 托盘
const { app, BrowserWindow, Menu, Tray, screen, ipcMain, shell, nativeImage, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const QRCode = require('qrcode')

// 收起态：仅角色尺寸；展开态：铺满工作区（透明区域鼠标穿透，卡片可在屏幕任意位置拖动）
const PET_SIZE = { width: 132, height: 148 }

let win = null
let tray = null
let expanded = false

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    x: sw - PET_SIZE.width - 36,
    y: sh - PET_SIZE.height - 36,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show(false))
  // 防休眠置顶：全屏应用切换时仍保持层级
  win.on('blur', () => win && win.setAlwaysOnTop(true, 'screen-saver'))
}

/**
 * 展开/收起：
 * - 展开：窗口铺满工作区，透明区域由渲染层判定并 setIgnoreMouseEvents 穿透，卡片可全屏拖动
 * - 收起：窗口收缩到渲染层给出的角色占位矩形（角色拖到哪，窗口收到哪）
 */
ipcMain.handle('toggle-chat', (_e, open, petRect) => {
  if (!win) return { ok: false }
  if (open) {
    expanded = true
    const wa = screen.getPrimaryDisplay().workArea
    const old = win.getBounds()
    // 返回旧窗口相对工作区的偏移：渲染层据此把角色钉在原屏幕位置，避免“闪开”
    const petAnchor = { x: old.x - wa.x, y: old.y - wa.y }
    win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height })
    // 注意：此处不得开启穿透——展开瞬间光标在角色上（属 UI），应保持可点击；
    // 透明区穿透完全由渲染层按鼠标位置接管，否则两边状态脱钩导致点击穿透桌面
    return { ok: true, petAnchor }
  } else {
    expanded = false
    win.setIgnoreMouseEvents(false)
    const b = win.getBounds()
    const r = petRect || { x: b.width - PET_SIZE.width, y: b.height - PET_SIZE.height, width: PET_SIZE.width, height: PET_SIZE.height }
    win.setBounds({
      x: b.x + Math.round(r.x),
      y: b.y + Math.round(r.y),
      width: Math.round(r.width || PET_SIZE.width),
      height: Math.round(r.height || PET_SIZE.height),
    })
    return { ok: true }
  }
})

/** 透明区域鼠标穿透开关（forward：穿透时仍转发鼠标移动，便于移回 UI 时恢复捕获） */
ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  if (!win || !expanded) return
  win.setIgnoreMouseEvents(!!ignore, { forward: true })
})

/** 收起态拖动角色 = 拖动窗口（展开态角色/卡片由渲染层在全屏窗口内拖动） */
ipcMain.on('win-move', (_e, { dx, dy }) => {
  if (!win || expanded) return
  const cur = win.getBounds()
  const wa = screen.getPrimaryDisplay().workArea
  const x = Math.min(Math.max(cur.x + dx, wa.x), wa.x + wa.width - 60)
  const y = Math.min(Math.max(cur.y + dy, wa.y), wa.y + wa.height - 40)
  win.setBounds({ x, y })
})

/** 右键菜单：动态项目列表 + 常用操作 */
ipcMain.on('context-menu', (_e, { projects, currentId, projectName }) => {
  const projItems = (projects || []).map((p) => ({
    label: `${p.id === currentId ? '● ' : '○ '}${p.name}`,
    click: () => win.webContents.send('menu-switch-project', p.id),
  }))
  Menu.buildFromTemplate([
    { label: `当前项目：${projectName || '未设置'}`, enabled: false },
    { type: 'separator' },
    { label: '切换项目', submenu: projItems.length ? projItems : [{ label: '（暂无项目）', enabled: false }] },
    {
      label: 'AI 表格',
      click: () => win.webContents.send('menu-open-table'),
    },
    {
      label: '动作视频…',
      click: () => win.webContents.send('menu-pick-video'),
    },
    { type: 'separator' },
    {
      label: '账号…',
      accelerator: 'CmdOrCtrl+,',
      click: () => win.webContents.send('menu-open-settings'),
    },
    { type: 'separator' },
    {
      label: '退出秒建功',
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        tray?.destroy()
        app.quit()
      },
    },
  ]).popup({ window: win })
})

ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url)
})

/** 文本 → 二维码 dataURL（钉钉扫码配对登录用，主进程生成避免渲染层引入依赖） */
ipcMain.handle('qr-dataurl', async (_e, text) => {
  try {
    return await QRCode.toDataURL(text, { width: 300, margin: 1, errorCorrectionLevel: 'M' })
  } catch {
    return ''
  }
})

/* ============ 桌宠动作视频（绿幕抠像动画） ============ */
// 自定义视频复制进 userData（原文件被移动/删除也不影响），配置仅记录路径与名称
const videoCfgPath = () => path.join(app.getPath('userData'), 'action-video.json')
function readVideoCfg() {
  try { return JSON.parse(fs.readFileSync(videoCfgPath(), 'utf8')) } catch { return null }
}
/** 读取当前动作视频字节流：用户自定义优先，否则用内置默认 */
function readActionVideo() {
  const cfg = readVideoCfg()
  let file = cfg?.path && fs.existsSync(cfg.path) ? cfg.path : path.join(__dirname, 'assets', 'action.mp4')
  if (!fs.existsSync(file)) return { ok: false, name: cfg?.name || '' }
  const buf = fs.readFileSync(file)
  return {
    ok: true,
    name: cfg?.path === file ? cfg.name : '默认动作视频',
    data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), // ArrayBuffer，IPC 结构化克隆
  }
}
ipcMain.handle('action-video:get', () => {
  try { return readActionVideo() } catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('action-video:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择绿幕动作视频',
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'webm', 'm4v'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true }
  const src = r.filePaths[0]
  const ext = path.extname(src).toLowerCase() || '.mp4'
  const dest = path.join(app.getPath('userData'), `action-video${ext}`)
  fs.copyFileSync(src, dest)
  const name = path.basename(src)
  fs.writeFileSync(videoCfgPath(), JSON.stringify({ path: dest, name }))
  try { return readActionVideo() } catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('action-video:clear', () => {
  try { fs.unlinkSync(videoCfgPath()) } catch { /* 无配置即默认 */ }
  try { return readActionVideo() } catch (e) { return { ok: false, error: e.message } }
})

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('秒建功 · 工作台账桌面助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示/隐藏 桌宠', click: () => (win.isVisible() ? win.hide() : win.show()) },
      { label: '账号…', click: () => { win.show(); win.webContents.send('menu-open-settings') } },
      { type: 'separator' },
      { label: '退出', click: () => { tray.destroy(); app.quit() } },
    ]),
  )
  tray.on('click', () => (win.isVisible() ? win.focus() : win.show()))
}

app.whenReady().then(() => {
  createWindow()
  createTray()
  // mac 激活：窗口可能被隐藏，点图标重新显示
  app.on('activate', () => win?.show())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
