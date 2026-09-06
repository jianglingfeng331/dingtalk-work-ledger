/* 秒建功 · 渲染层交互：桌宠拖动/点击/右键、气泡菜单、扫码登录、AI查询、填报、项目切换 */
const $ = (id) => document.getElementById(id)
const pet = $('pet'), panel = $('panel'), panelFill = $('panel-fill'), panelTasks = $('panel-tasks'), quickMenu = $('quick-menu'), loginCard = $('login-card')
const msgs = $('msgs')

/* 窗口两种形态：收起=纯角色小窗；展开=铺满工作区透明窗（透明区鼠标穿透，卡片可全屏拖动） */
let expanded = false
let activeView = null // 'menu' | 'login' | 'chat' | 'fill' | 'tasks' | null
let loggedIn = false
let userName = localStorage.getItem('userName') || ''
let querying = false
let projects = []
let tasksLoaded = false

/* ============ 轻提示 ============ */
let toastTimer = null
function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200)
}

/* ============ 桌宠：拖动 / 点击 / 右键 ============ */
let drag = null
pet.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  drag = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY, moved: false, startRect: null }
  pet.classList.add('dragging')
  if (expanded) {
    forceCapture = true
    setIgnore(false)
  }
})
window.addEventListener('mousemove', (e) => {
  if (!drag) return
  const dx = e.screenX - drag.sx
  const dy = e.screenY - drag.sy
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
  if (!drag.moved) return
  if (expanded) {
    // 展开态：窗口铺满屏幕，直接拖角色元素
    if (!drag.startRect) drag.startRect = pet.getBoundingClientRect()
    const x = clamp(drag.startRect.left + (e.clientX - drag.cx), 0, window.innerWidth - pet.offsetWidth)
    const y = clamp(drag.startRect.top + (e.clientY - drag.cy), 0, window.innerHeight - pet.offsetHeight)
    pet.style.right = 'auto'
    pet.style.bottom = 'auto'
    pet.style.left = `${x}px`
    pet.style.top = `${y}px`
  } else {
    // 收起态：窗口=角色，拖窗口
    window.desktop.winMove(dx, dy)
    drag.sx = e.screenX
    drag.sy = e.screenY
  }
})
window.addEventListener('mouseup', () => {
  if (!drag) return
  const wasClick = !drag.moved
  drag = null
  forceCapture = false
  pet.classList.remove('dragging')
  if (!wasClick) return
  // 点击角色：展开中→全部收起；收起中→弹出气泡菜单
  if (activeView || expanded) closeAll()
  else openView('menu')
})
pet.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const cur = projects.find((p) => p.id === localStorage.getItem('projectId'))
  window.desktop.contextMenu({
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    currentId: localStorage.getItem('projectId') || '',
    projectName: cur?.name || '',
  })
})

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max)
}

/* ============ 视图开合 ============ */
async function setExpanded(open) {
  expanded = open
  if (open) {
    const res = await window.desktop.toggleChat(true)
    // 窗口从小窗铺满工作区时，把角色钉在原屏幕位置，避免视觉上“闪开”
    if (res?.petAnchor) {
      pet.style.right = 'auto'
      pet.style.bottom = 'auto'
      pet.style.left = `${res.petAnchor.x}px`
      pet.style.top = `${res.petAnchor.y}px`
    }
    // 展开瞬间光标必在角色上（属 UI）：强制恢复捕获，后续由 mousemove 按位置接管穿透，
    // 消除“弹出菜单后不动鼠标直接点击会穿透到桌面”的状态脱钩
    setIgnore(false, true)
  } else {
    // 收起：把窗口收缩到角色当前所在位置（角色元素坐标 → 屏幕坐标由主进程换算）
    const r = pet.getBoundingClientRect()
    await window.desktop.toggleChat(false, { x: r.left, y: r.top, width: r.width, height: r.height })
    pet.style.left = pet.style.top = pet.style.right = pet.style.bottom = ''
    setIgnore(false)
  }
}

function showView(name) {
  activeView = name
  quickMenu.classList.toggle('open', name === 'menu')
  loginCard.classList.toggle('open', name === 'login')
  panel.classList.toggle('open', name === 'chat')
  panelFill.classList.toggle('open', name === 'fill')
  panelTasks.classList.toggle('open', name === 'tasks')
}

async function openView(name) {
  if (!expanded) await setExpanded(true)
  showView(name)
  // 打开主菜单时补拉任务数（启动时加载失败可在此重试，徽标及时显示）
  if (name === 'menu' && loggedIn) loadTasksOnce()
}

async function closeAll() {
  stopPair()
  $('settings').classList.remove('open')
  showView(null)
  if (expanded) await setExpanded(false)
}

/* ============ 透明区域鼠标穿透（铺满屏窗口只在 UI 矩形区域捕获鼠标） ============ */
let ignoring = false
let forceCapture = false // 拖动卡片/角色期间强制捕获，避免指针快速移出 UI 丢失事件
/* 所有需要捕获鼠标的 UI 容器：菜单整块、卡片整块、角色、账号卡片、提示条。
   注意：#settings 是全屏透明遮罩，不能整体捕获（否则挡住桌面），只捕获其内部 .set-card */
const UI_SEL = '#quick-menu, .float-card, #pet, .set-card, #toast'
function hitUI(x, y) {
  // elementFromPoint 基于布局做命中测试（不受背景透明度影响），
  // 菜单/卡片矩形内的任意空白（按钮行间隙、padding、透明背景）都算 UI，不穿透
  const el = document.elementFromPoint(x, y)
  return !!(el && el.closest && el.closest(UI_SEL))
}
function setIgnore(ignore, force = false) {
  if (!force) {
    if (forceCapture) ignore = false
    if (ignore === ignoring) return
  }
  ignoring = ignore
  window.desktop.setIgnoreMouse(ignore)
}
function refreshMousePassThrough(e) {
  if (!expanded) return
  setIgnore(!hitUI(e.clientX, e.clientY))
}
document.addEventListener('mousemove', refreshMousePassThrough)
// mouseover 兜底：进入任一 UI 元素时立即恢复捕获（比 mousemove 判定更及时）
document.addEventListener('mouseover', (e) => {
  if (!expanded || forceCapture) return
  if (e.target && e.target.closest && e.target.closest(UI_SEL)) setIgnore(false)
})

/* ============ 悬浮卡片/主菜单自由拖动（按住顶部手柄拖到屏幕任意位置，位置持久化） ============ */
function makeDraggable(el) {
  const handle = el.querySelector('[data-drag]')
  if (!handle) return
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.card-close') || e.target.closest('button')) return
    e.preventDefault()
    forceCapture = true
    setIgnore(false)
    const rect = el.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    el.style.right = 'auto'
    el.style.bottom = 'auto'
    el.style.left = `${rect.left}px`
    el.style.top = `${rect.top}px`
    let moved = false
    const move = (ev) => {
      moved = true
      const x = clamp(rect.left + (ev.clientX - startX), 4, window.innerWidth - el.offsetWidth - 4)
      const y = clamp(rect.top + (ev.clientY - startY), 4, window.innerHeight - el.offsetHeight - 4)
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      forceCapture = false
      if (moved) localStorage.setItem(`cardPos:${el.id}`, JSON.stringify({ x: el.style.left, y: el.style.top }))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}
function initDraggable(el) {
  makeDraggable(el)
  const saved = localStorage.getItem(`cardPos:${el.id}`)
  if (saved) {
    try {
      const pos = JSON.parse(saved)
      el.style.right = 'auto'
      el.style.bottom = 'auto'
      el.style.left = pos.x
      el.style.top = pos.y
    } catch { /* 忽略损坏的位置缓存 */ }
  }
}
document.querySelectorAll('.float-card').forEach(initDraggable)
initDraggable(quickMenu)

/* ============ 我的任务面板 ============ */
const taskList = $('task-list')
let tasksCache = []
const DUE_SOON_DAYS = 3 // 距计划节点不足 N 天视为“即将逾期”（与移动端一致）
async function loadTasksForPanel() {
  taskList.innerHTML = '<div class="task-loading">任务加载中…</div>'
  try {
    tasksCache = await getMyTasks()
    updateTaskCount(tasksCache.length)
    renderTasks(tasksCache)
  } catch (e) {
    taskList.innerHTML = `<div class="task-empty">加载失败：${e.message || '网络错误'}</div>`
  }
}
function updateTaskCount(n) {
  const badge = $('qm-tasks-count')
  if (!badge) return
  // 无任务/加载失败时隐藏徽标：宁可不见，也不显示空灰圈
  if (n > 0) {
    badge.textContent = n > 99 ? '99+' : String(n)
    badge.style.display = ''
  } else {
    badge.textContent = ''
    badge.style.display = 'none'
  }
}
/* 任务紧急度分组：1已逾期 2即将逾期(3天内) 3进行中 4未开始 5已完成 6已取消 7其他 */
function taskRank(t, today) {
  const status = t.status || '未开始'
  if (status === '已取消') return 6
  if (status === '已完成') return 5
  if (t.planDate && t.planDate < today) return 1 // 已逾期（未完成且过计划节点）
  if (t.planDate) {
    const diff = (Date.parse(t.planDate) - Date.parse(today)) / 86400000
    if (Number.isFinite(diff) && diff >= 0 && diff < DUE_SOON_DAYS) return 2 // 即将逾期
  }
  if (status === '进行中') return 3
  return 4 // 未开始/其他未完成
}
function sortTasks(tasks) {
  const today = new Date().toISOString().slice(0, 10)
  return [...tasks].sort((a, b) => {
    const ra = taskRank(a, today)
    const rb = taskRank(b, today)
    if (ra !== rb) return ra - rb
    // 同组内：有计划日期的按日期升序（越早越紧急），无日期排后
    if (a.planDate && b.planDate) return a.planDate.localeCompare(b.planDate)
    if (a.planDate) return -1
    if (b.planDate) return 1
    return 0
  })
}
function statusMeta(status) {
  if (status === '已完成') return { cls: 's-done', label: status }
  if (status === '进行中') return { cls: 's-doing', label: status }
  if (status === '已取消') return { cls: 's-todo', label: status }
  return { cls: 's-todo', label: status || '未开始' }
}
function renderTasks(tasks) {
  updateTaskCount(tasks.length)
  if (!tasks.length) {
    taskList.innerHTML =
      '<div class="task-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><span>当前没有与你相关的任务</span></div>'
    return
  }
  const today = new Date().toISOString().slice(0, 10)
  taskList.textContent = ''
  sortTasks(tasks).forEach((t) => {
    const meta = statusMeta(t.status)
    let dateCls = ''
    let dateText = '无计划日期'
    if (t.planDate) {
      const diff = (Date.parse(t.planDate) - Date.parse(today)) / 86400000
      const overdue = diff < 0 && t.status !== '已完成' && t.status !== '已取消'
      const soon = !overdue && Number.isFinite(diff) && diff >= 0 && diff < DUE_SOON_DAYS && t.status !== '已完成' && t.status !== '已取消'
      dateCls = overdue ? 'overdue' : soon ? 'soon' : ''
      const tag = overdue ? '（已逾期）' : soon ? (diff === 0 ? '（今天到期）' : `（剩${Math.round(diff)}天）`) : ''
      dateText = `${t.planDate}${tag}`
    }
    const item = document.createElement('div')
    item.className = 'task-item'
    item.innerHTML = `
      <div class="ti-title"></div>
      <div class="ti-meta">
        <span class="ti-status ${meta.cls}">${meta.label}</span>
        <span class="ti-date ${dateCls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${dateText}</span>
      </div>`
    item.querySelector('.ti-title').textContent = t.title || '（未命名任务）'
    taskList.appendChild(item)
  })
}

/* ============ 登录态 → 菜单按钮状态 ============ */
const ICO_SCAN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v3"/><path d="M12 8v3"/><path d="M17 8v3"/></svg>'
const ICO_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'

function updateQuickMenu() {
  const loginBtn = $('qm-login')
  const displayName = userName || '钉钉用户'
  loginBtn.className = `qm-row${loggedIn ? '' : ' accent'}`
  loginBtn.title = loggedIn ? '账号管理' : '用钉钉 App 扫码登录'
  loginBtn.innerHTML = `
    <span class="qm-ico">${loggedIn ? ICO_USER : ICO_SCAN}</span>
    <span class="qm-txt">${loggedIn ? displayName : '钉钉扫码登录'}</span>`

  $('qm-fill').disabled = !loggedIn
  $('qm-ai').disabled = !loggedIn
  $('qm-tasks').disabled = !loggedIn
  $('qm-state').textContent = loggedIn ? displayName : '未登录'
  if (!loggedIn) updateTaskCount(0)
  $('s-logout').style.display = loggedIn ? '' : 'none'
  $('s-state').textContent = loggedIn ? displayName : '未登录'
  $('s-user-name').textContent = loggedIn ? displayName : '尚未登录'
}

/* ============ 快捷菜单点击（AI查询 / 填报日志 为两个独立弹层） ============ */
$('qm-login').onclick = () => (loggedIn ? openSettings() : openLogin())
$('qm-account').onclick = () => openSettings()
$('qm-fill').onclick = () => {
  if (!loggedIn) return
  openView('fill')
  loadTasksOnce()
  $('f-content').focus()
}
$('qm-ai').onclick = () => {
  if (!loggedIn) return
  openView('chat')
  ensureWelcome() // 打开即是完整对话界面（欢迎语 + 快捷提问）
  $('q-input').focus()
}
$('qm-tasks').onclick = () => {
  if (!loggedIn) return
  openView('tasks')
  loadTasksForPanel()
}

/* ============ 卡片关闭 ============ */
$('btn-close').onclick = () => closeAll()
$('btn-fill-close').onclick = () => closeAll()
$('btn-tasks-close').onclick = () => closeAll()

/* ============ 扫码登录卡 ============ */
function openLogin() {
  openView('login')
  startPair()
}
$('lc-close').onclick = () => closeAll()

/* ============ 钉钉扫码配对登录 ============ */
let pairTimer = null
let pairBusy = false
let pairLink = ''

function stopPair() {
  if (pairTimer) {
    clearInterval(pairTimer)
    pairTimer = null
  }
}

async function startPair() {
  if (pairBusy) return
  pairBusy = true
  $('pair-tip').textContent = '正在生成二维码…'
  $('pair-refresh').style.display = 'none'
  try {
    const server = currentServer()
    const { pairId } = await createPair()
    pairLink = `${server}/#/desktop-pair?pair=${pairId}`
    const qr = await window.desktop?.qrDataUrl?.(pairLink)
    if (!qr) throw new Error('二维码生成失败')
    $('pair-qr').src = qr
    $('pair-tip').innerHTML = '打开 <b>钉钉 App</b> 扫码，在手机上确认授权'

    stopPair()
    pairTimer = setInterval(async () => {
      let r
      try {
        r = await pollPair(pairId)
      } catch {
        return // 网络抖动，下轮继续
      }
      if (r.status === 'confirmed') {
        stopPair()
        savePairedSession(r)
        loggedIn = true
        userName = r.name || ''
        localStorage.setItem('userName', userName)
        localStorage.setItem('menuShown', '1')
        updateQuickMenu()
        showView('menu')
        toast(`登录成功：${userName || '钉钉用户'}`)
        loadProjects()
          .then(() => updateQuickMenu())
          .catch(() => {})
      } else if (r.status === 'expired') {
        stopPair()
        $('pair-tip').textContent = '二维码已过期（5 分钟有效）'
        $('pair-refresh').style.display = 'inline'
      }
    }, 2000)
  } catch (e) {
    $('pair-tip').textContent = e.message || '配对失败，请稍后重试'
    $('pair-refresh').style.display = 'inline'
  } finally {
    pairBusy = false
  }
}

$('pair-refresh').onclick = startPair
$('pair-copy').onclick = async () => {
  if (!pairLink) return
  try {
    await navigator.clipboard.writeText(pairLink)
    toast('链接已复制，发到钉钉里打开即可授权')
  } catch {
    toast('复制失败，请截图二维码发给钉钉扫码')
  }
}

/* ============ 账号浮层（与快捷菜单同位的毛玻璃卡片；遮罩透明，点外部关闭） ============ */
function openSettings() {
  stopPair()
  updateQuickMenu()
  // 账号卡锚定在角色左侧（与快捷菜单同位），先隐藏其他视图避免重叠
  ;(async () => {
    if (!expanded) await setExpanded(true)
    showView(null)
    $('settings').classList.add('open')
  })()
}
function closeSettings() {
  $('settings').classList.remove('open')
  closeAll()
}
$('s-cancel').onclick = closeSettings
$('settings').addEventListener('click', (e) => {
  if (e.target === $('settings')) closeSettings()
})

$('s-logout').onclick = () => {
  logout()
  localStorage.removeItem('desktopToken')
  localStorage.removeItem('userName')
  loggedIn = false
  userName = ''
  projects = []
  tasksLoaded = false
  tasksCache = []
  updateTaskCount(0)
  fTask.innerHTML = '<option value="">智能匹配</option>'
  welcomed = false
  msgs.textContent = ''
  updateQuickMenu()
  $('settings').classList.remove('open')
  closeAll()
  toast('已退出登录')
}

/* ============ 聊天：消息渲染 ============ */
function addMsg(cls, text) {
  const div = document.createElement('div')
  div.className = `msg ${cls}`
  div.textContent = text
  msgs.appendChild(div)
  msgs.scrollTop = msgs.scrollHeight
  return div
}
function addHint(text) {
  const div = document.createElement('div')
  div.className = 'status-hint'
  div.textContent = text
  msgs.appendChild(div)
  msgs.scrollTop = msgs.scrollHeight
  return div
}

/* 引导语与快捷提问：与 PC/移动端（H5 AI老谢）保持一致 */
const WELCOME = '你好，我是 AI老谢。可以直接问我工作数据，例如「本周我完成了哪些任务？」，我会基于团队台账给你统计与复盘。'
const QUICK_QUESTIONS = ['本周我完成了哪些任务？', '我有哪些未完成的任务？', '团队本周工作汇总']
let welcomed = false
function ensureWelcome() {
  if (welcomed) return
  welcomed = true
  addMsg('ai', WELCOME)
  const row = document.createElement('div')
  row.className = 'quick-row'
  QUICK_QUESTIONS.forEach((q) => {
    const chip = document.createElement('button')
    chip.className = 'quick-chip'
    chip.textContent = q
    chip.onclick = () => sendQuery(q)
    row.appendChild(chip)
  })
  msgs.appendChild(row)
  msgs.scrollTop = msgs.scrollHeight
}

/* ============ AI 查询（流式） ============ */
const qInput = $('q-input'), qSend = $('q-send')
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendQuery()
  }
})
qSend.onclick = () => sendQuery()

async function sendQuery(text) {
  const question = (text || qInput.value).trim()
  if (!question || querying) return
  if (!(await ensureLogin())) {
    openLogin()
    return toast('请先用钉钉扫码登录')
  }
  ensureWelcome()
  qInput.value = ''
  addMsg('me', question)
  const aiMsg = document.createElement('div')
  aiMsg.className = 'msg ai'
  aiMsg.textContent = '…'
  msgs.appendChild(aiMsg)
  msgs.scrollTop = msgs.scrollHeight
  const hint = addHint('正在统计台账数据，请稍候…')
  querying = true
  qSend.disabled = true
  const t0 = Date.now()
  let typing = false
  await aiQueryStream(question, {
    onToken: (delta) => {
      if (!typing) {
        typing = true
        aiMsg.textContent = ''
        hint.remove()
      }
      aiMsg.textContent += delta
      msgs.scrollTop = msgs.scrollHeight
    },
    onDone: () => {
      if (!typing) {
        aiMsg.textContent = 'AI 没有返回内容，请稍后重试'
        hint.remove()
      }
      console.log(`[chat] 完成 ${Date.now() - t0}ms`)
    },
    onError: (msg) => {
      aiMsg.className = 'msg err'
      aiMsg.textContent = msg
      hint.remove()
    },
  })
  querying = false
  qSend.disabled = false
}

/* ============ 填报 ============ */
const fContent = $('f-content'), fProgress = $('f-progress'), fHours = $('f-hours'), fTask = $('f-task')

async function loadTasksOnce() {
  if (tasksLoaded) return
  try {
    tasksCache = await getMyTasks()
    // 成功才置位：失败保持未加载，下次打开主菜单/面板时自动重试
    tasksLoaded = true
    updateTaskCount(tasksCache.length)
    tasksCache.forEach((t) => {
      const opt = document.createElement('option')
      opt.value = t.id
      opt.textContent = `${t.title}（${t.status}）`
      fTask.appendChild(opt)
    })
  } catch {
    /* 任务列表拉取失败不阻塞填报（智能匹配兜底） */
  }
}

/* 输入即预解析：识别进度/工时回填表单 */
let parseTimer = null
fContent.addEventListener('input', () => {
  clearTimeout(parseTimer)
  parseTimer = setTimeout(async () => {
    const content = fContent.value.trim()
    const card = $('parse-card')
    if (!content) {
      card.classList.remove('show')
      return
    }
    try {
      const p = await parseWork(content)
      fProgress.value = p.progress || '未开始'
      if (p.hours) fHours.value = p.hours
      const sub = []
      if (p.hours) sub.push(`工时 ${p.hours} 小时`)
      if (p.title) sub.push(`建议任务「${p.title}」`)
      card.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>' +
        `<span><span class="pc-main">AI 已自动填好「完成情况」${p.hours ? '和「工时」' : ''}</span>` +
        `<span class="pc-sub">${sub.length ? sub.join(' · ') + '，' : ''}不对可在下方直接修改</span></span>`
      card.classList.add('show')
    } catch {
      card.classList.remove('show')
    }
  }, 600)
})

$('f-submit').onclick = async () => {
  const content = fContent.value.trim()
  if (!content) return toast('先写点什么吧')
  if (!(await ensureLogin())) {
    openLogin()
    return toast('请先用钉钉扫码登录')
  }
  const btn = $('f-submit')
  btn.disabled = true
  btn.textContent = '提交中…'
  try {
    const overrides = { progress: fProgress.value }
    if (fHours.value !== '') overrides.hours = Number(fHours.value)
    await submitWork(content, overrides, fTask.value)
    $('ok-text').textContent = '已记录到当前项目台账'
    $('ok-card').classList.add('show')
    fContent.value = ''
    fHours.value = ''
    $('parse-card').classList.remove('show')
    setTimeout(() => $('ok-card').classList.remove('show'), 1800)
  } catch (e) {
    toast(e.message)
  } finally {
    btn.disabled = false
    btn.textContent = '提交日志'
  }
}

/* ============ 项目加载与切换（当前项目通过右键菜单查看/切换） ============ */
async function loadProjects() {
  const d = await getProjects()
  projects = d.projects || []
  let cur = projects.find((p) => p.id === localStorage.getItem('projectId'))
  if (!cur) cur = projects[0]
  if (cur) localStorage.setItem('projectId', cur.id)
}

/* 主进程菜单事件 */
window.desktop.onMenuSwitchProject(async (id) => {
  const p = projects.find((x) => x.id === id)
  if (!p) return
  localStorage.setItem('projectId', id)
  tasksLoaded = false
  fTask.innerHTML = '<option value="">智能匹配</option>'
  loadTasksOnce()
  if (activeView === 'tasks') loadTasksForPanel() // 任务面板开着时实时刷新
  toast(`已切换到「${p.name}」`)
})
window.desktop.onMenuOpenSettings(() => {
  openSettings()
})
window.desktop.onMenuOpenTable(() => {
  const cur = projects.find((p) => p.id === localStorage.getItem('projectId'))
  if (cur?.baseId) window.desktop.openExternal(tableUrl(cur.baseId))
  else toast('当前项目暂无AI表格地址')
})

/* ============ 启动 ============ */
async function boot() {
  updateQuickMenu()
  const ok = await ensureLogin()
  loggedIn = ok
  if (ok && !userName) userName = localStorage.getItem('userName') || ''
  updateQuickMenu()

  if (!ok) {
    // 未登录（含首次安装启动）：角色直接可见，自动弹出气泡菜单引导扫码
    await openView('menu')
    return
  }
  try {
    await loadProjects()
    loadTasksOnce() // 预加载我的任务，填充 AI 查询卡底部任务数角标
    // 登录用户首次运行：弹一次菜单展示可用功能
    if (!localStorage.getItem('menuShown')) {
      localStorage.setItem('menuShown', '1')
      await openView('menu')
    }
  } catch (e) {
    toast(e.message)
  }
}
boot()
