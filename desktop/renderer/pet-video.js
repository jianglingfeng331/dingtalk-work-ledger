/* ============ 桌宠动作视频：背景抠像 + 随机 1-3 分钟自动播放 ============
 * 方案：隐藏 <video> 解码 → requestAnimationFrame 逐帧 drawImage 到小尺寸 canvas →
 * 自动识别背景类型（暗底/绿幕/纯色），用「边缘洪水填充」抠除背景：
 * 只有与画面边缘连通的背景像素变透明，角色内部的深色部分（眼睛、轮廓线）保留。
 * 桌宠显示尺寸仅 108px，逐帧处理开销可忽略；canvas 不拦截鼠标，不干扰桌面操作。
 */
;(function () {
  const pet = document.getElementById('pet')
  const video = document.getElementById('pet-video')
  const canvas = document.getElementById('pet-canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const DISPLAY = 108 // 与 CSS 中角色显示尺寸一致
  const DPR = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = DISPLAY * DPR
  canvas.height = DISPLAY * DPR

  // 背景判定阈值
  const LUMA_HARD = 95 // 亮度低于此值 → 暗背景像素
  const LUMA_SOFT = 150 // 低于此值且紧邻透明区 → 边缘半透明
  const GREEN_HARD = 28 // greenness 高于此值 → 绿幕像素
  const GREEN_SOFT = 10
  const CHROMA_HARD = 70 // 与背景色距离小于此值 → 纯色背景
  const CHROMA_SOFT = 110

  let rafId = 0
  let scheduleTimer = 0
  let videoReady = false
  let acting = false
  let objectUrl = ''

  function loadVideo(arrayBuf) {
    if (!arrayBuf || !arrayBuf.byteLength) return
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    // 不指定 MIME，让 Chromium 自行嗅探（mp4/mov/webm 均可）
    objectUrl = URL.createObjectURL(new Blob([arrayBuf]))
    video.src = objectUrl
    videoReady = false
    video.load()
  }

  video.addEventListener('loadeddata', () => { videoReady = true })
  video.addEventListener('error', () => {
    videoReady = false
    if (acting) stopActing()
    scheduleNext()
  })

  /** 采样画面边框像素，识别背景类型：luma（暗底）/ green（绿幕）/ chroma（其他纯色） */
  function detectMode(d, w, h) {
    let rS = 0, gS = 0, bS = 0, lumS = 0, greenS = 0, cnt = 0
    const sample = (x, y) => {
      const i = (y * w + x) * 4
      const r = d[i], g = d[i + 1], b = d[i + 2]
      rS += r; gS += g; bS += b
      lumS += 0.299 * r + 0.587 * g + 0.114 * b
      greenS += g - Math.max(r, b)
      cnt++
    }
    for (let x = 0; x < w; x += 4) { sample(x, 0); sample(x, h - 1) }
    for (let y = 0; y < h; y += 4) { sample(0, y); sample(w - 1, y) }
    const avgLum = lumS / cnt
    const avgGreen = greenS / cnt
    if (avgLum < 90) return { mode: 'luma' }
    if (avgGreen > 25) return { mode: 'green' }
    return { mode: 'chroma', bg: [rS / cnt, gS / cnt, bS / cnt] }
  }

  /** 像素是否属于「硬背景」（会被洪水填充抠除）：暗底/绿幕/纯色底任一命中即可 */
  function isHardBg(r, g, b, bg) {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (lum < LUMA_HARD) return true
    if (g - Math.max(r, b) > GREEN_HARD) return true
    if (bg) {
      const dr = r - bg[0], dg = g - bg[1], db = b - bg[2]
      if (dr * dr + dg * dg + db * db < CHROMA_HARD * CHROMA_HARD) return true
    }
    return false
  }
  /** 像素是否属于「软背景」（紧邻透明区时半透明羽化 + 去色边） */
  function isSoftBg(r, g, b, bg) {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (lum < LUMA_SOFT) return true
    if (g - Math.max(r, b) > GREEN_SOFT) return true
    if (bg) {
      const dr = r - bg[0], dg = g - bg[1], db = b - bg[2]
      if (dr * dr + dg * dg + db * db < CHROMA_SOFT * CHROMA_SOFT) return true
    }
    return false
  }
  function isGreenish(r, g, b) {
    return g - Math.max(r, b) > GREEN_SOFT
  }

  /** 逐帧：等比 contain 绘制 + 边缘洪水填充抠像 */
  function drawFrame() {
    if (!acting) return
    const cw = canvas.width
    const ch = canvas.height
    ctx.clearRect(0, 0, cw, ch)
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw && vh && video.readyState >= 2) {
      const scale = Math.min(cw / vw, ch / vh)
      const dw = vw * scale
      const dh = vh * scale
      ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
      const img = ctx.getImageData(0, 0, cw, ch)
      const d = img.data
      const n = cw * ch
      const { bg } = detectMode(d, cw, ch)

      // 1) 标记硬背景像素
      const hard = new Uint8Array(n)
      for (let p = 0; p < n; p++) {
        const i = p * 4
        if (isHardBg(d[i], d[i + 1], d[i + 2], bg)) hard[p] = 1
      }
      // 2) 从四条边开始洪水填充：仅与边缘连通的硬背景变透明
      //    （角色内部的深色区域如眼睛、轮廓线被亮区包围，不会被抠到）
      const reached = new Uint8Array(n)
      const stack = []
      for (let x = 0; x < cw; x++) { stack.push(x, (ch - 1) * cw + x) }
      for (let y = 0; y < ch; y++) { stack.push(y * cw, y * cw + cw - 1) }
      while (stack.length) {
        const p = stack.pop()
        if (reached[p] || !hard[p]) continue
        reached[p] = 1
        const x = p % cw
        if (x > 0) stack.push(p - 1)
        if (x < cw - 1) stack.push(p + 1)
        if (p >= cw) stack.push(p - cw)
        if (p < n - cw) stack.push(p + cw)
      }
      // 3) 应用透明 + 边缘羽化（软背景像素紧邻透明区 → 半透明，绿色像素同时去绿溢）
      for (let p = 0; p < n; p++) {
        const i = p * 4
        if (reached[p]) { d[i + 3] = 0; continue }
        const x = p % cw
        const nearTransparent =
          (x > 0 && reached[p - 1]) || (x < cw - 1 && reached[p + 1]) ||
          (p >= cw && reached[p - cw]) || (p < n - cw && reached[p + cw])
        if (nearTransparent && isSoftBg(d[i], d[i + 1], d[i + 2], bg)) {
          d[i + 3] = Math.round(d[i + 3] * 0.45)
        }
        if (isGreenish(d[i], d[i + 1], d[i + 2])) {
          d[i + 1] = Math.max(d[i], d[i + 2]) // 去绿溢
        }
      }
      ctx.putImageData(img, 0, 0)
    }
    rafId = requestAnimationFrame(drawFrame)
  }

  function playAction() {
    if (acting) return
    if (!videoReady || video.error) { scheduleNext(); return }
    acting = true
    pet.classList.add('acting')
    video.currentTime = 0
    video.play().catch(() => stopActing())
    rafId = requestAnimationFrame(drawFrame)
  }

  function stopActing() {
    acting = false
    pet.classList.remove('acting')
    cancelAnimationFrame(rafId)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    scheduleNext()
  }

  video.addEventListener('ended', stopActing)

  /** 随机 60-180 秒后播放一次 */
  function scheduleNext() {
    clearTimeout(scheduleTimer)
    const delay = (60 + Math.random() * 120) * 1000
    scheduleTimer = setTimeout(playAction, delay)
  }

  function notify(text) {
    if (typeof window.toast === 'function') window.toast(text)
  }

  async function pickVideo() {
    try {
      const r = await window.desktop.pickActionVideo()
      if (r?.canceled) return
      if (r?.ok && r.data) {
        loadVideo(r.data)
        notify('动作视频已更新' + (r.name ? `：${r.name}` : ''))
      } else {
        notify('视频加载失败，请换一个视频文件')
      }
    } catch {
      notify('选择视频失败')
    }
  }

  async function resetVideo() {
    try {
      const r = await window.desktop.clearActionVideo()
      if (r?.ok && r.data) {
        loadVideo(r.data)
        notify('已恢复默认动作视频')
      }
    } catch {
      notify('恢复失败')
    }
  }

  // 右键菜单 / 设置卡入口
  window.desktop.onMenuPickVideo?.(pickVideo)
  document.getElementById('s-video-pick')?.addEventListener('click', pickVideo)
  document.getElementById('s-video-reset')?.addEventListener('click', resetVideo)

  // 启动：拉取当前视频（用户自定义优先，否则内置默认），然后开始随机调度
  ;(async function init() {
    try {
      const r = await window.desktop.getActionVideo()
      if (r?.ok && r.data) loadVideo(r.data)
    } catch { /* 无视频则保持静态图片 */ }
    scheduleNext()
  })()
})()
