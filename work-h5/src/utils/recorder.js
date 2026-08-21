/**
 * 录音 + WAV 编码工具（云端语音识别用）
 * WebSpeech 在国内网络/内嵌浏览器不可用时，本地录音转 16k 单声道 WAV 上传后端转写
 */

/** 录音会话：getUserMedia + MediaRecorder 采集，结束输出 WAV Blob */
export class WavRecorder {
  constructor() {
    this.stream = null
    this.recorder = null
    this.chunks = []
    this.mime = ''
  }

  static supported() {
    return (
      typeof window !== 'undefined' &&
      navigator.mediaDevices?.getUserMedia &&
      typeof window.MediaRecorder !== 'undefined'
    )
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.chunks = []
    this.mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
    this.recorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined)
    this.recorder.ondataavailable = (e) => {
      if (e.data?.size) this.chunks.push(e.data)
    }
    this.recorder.start(250)
  }

  /** 结束录音并转写为 16k 单声道 WAV；时长过短返回 null */
  async stopWav() {
    const done = new Promise((resolve) => {
      this.recorder.onstop = resolve
    })
    this.recorder.stop()
    await done
    this.stream?.getTracks().forEach((t) => t.stop())

    const blob = new Blob(this.chunks, { type: this.mime || 'audio/webm' })
    if (!blob.size) return null
    const buf = await blob.arrayBuffer()
    const ctx = new AudioContext()
    let audio
    try {
      audio = await ctx.decodeAudioData(buf)
    } finally {
      ctx.close()
    }
    if (audio.duration < 0.3) return null
    return encodeWav(await resample16kMono(audio))
  }
}

/** 重采样为 16k 单声道 */
async function resample16kMono(audio) {
  const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000)
  const src = off.createBufferSource()
  src.buffer = audio
  src.connect(off.destination)
  src.start()
  return off.startRendering()
}

/** AudioBuffer → 16bit PCM WAV Blob */
function encodeWav(buffer) {
  const ch = buffer.getChannelData(0)
  const len = ch.length
  const out = new ArrayBuffer(44 + len * 2)
  const view = new DataView(out)

  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  ws(0, 'RIFF')
  view.setUint32(4, 36 + len * 2, true)
  ws(8, 'WAVE')
  ws(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ws(36, 'data')
  view.setUint32(40, len * 2, true)

  let p = 44
  for (let i = 0; i < len; i++, p += 2) {
    const s = Math.max(-1, Math.min(1, ch[i]))
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([out], { type: 'audio/wav' })
}

/** 上传 WAV 到后端转写，返回文本 */
export async function transcribeWav(wavBlob, token) {
  const res = await fetch('/api/asr', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${token}` },
    body: wavBlob,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.code !== 0) throw new Error(data?.message || `转写失败(${res.status})`)
  return data.data?.text || ''
}
