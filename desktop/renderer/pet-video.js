/* ============ 桌宠动作视频：绿幕抠像 + 随机 1-3 分钟自动播放 ============
 * 方案：隐藏 <video> 解码 → requestAnimationFrame 逐帧 drawImage 到小尺寸 canvas →
 * 逐像素绿幕抠像（绿色显著高于红/蓝 → 透明，边缘羽化去绿边）。
 * 桌宠显示尺寸仅 108px，逐帧像素处理开销可忽略；播放时鼠标事件穿透 canvas，不干扰操作。
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

  // 绿幕阈值（greenness = 绿色通道 - max(红,蓝)）
  const GREEN_CUT = 30 // 大于 → 完全透明（纯绿幕，降低阈值让暗绿也抠掉）
  const GREEN_SOFT = 8 // 大于 → 边缘羽化半透明 + 去绿边
  const MIN_GREEN = 40 // 绿色通道低于此值不判定（保护深色衣服/头发）
  const SPILL_CUT = 12 // 去绿溢：绿色比红蓝高出此值时，把绿色压到 max(红,蓝)

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

  /** 逐帧：等比 contain 绘制 + 绿幕抠像 */
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
      for (let i = 0; i < d.length; i += 4) {
        const g = d[i + 1]
        if (g < MIN_GREEN) continue
        const r = d[i]
        const b = d[i + 2]
        const greenness = g - Math.max(r, b)
        if (greenness > GREEN_CUT) {
          d[i + 3] = 0 // 纯绿幕 → 全透明
        } else if (greenness > GREEN_SOFT) {
          const t = (greenness - GREEN_SOFT) / (GREEN_CUT - GREEN_SOFT) // 0..1
          d[i + 3] = Math.round(d[i + 3] * (1 - t)) // 边缘羽化
          d[i + 1] = Math.max(r, b) // 压掉绿色溢出（去绿边）
        } else if (greenness > SPILL_CUT) {
          // 非边缘但仍有绿溢：把绿色压到 max(红,蓝)
          d[i + 1] = Math.max(r, b)
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
