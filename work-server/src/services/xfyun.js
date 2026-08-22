import crypto from 'node:crypto'
import WebSocket from 'ws'
import { getAsr } from './settings.js'

/**
 * 讯飞语音听写（WebAPI，传统引擎非大模型，免费额度每日500次）
 * 鉴权：HMAC-SHA256 签名拼接在 WebSocket URL；音频：16k 16bit 单声道 PCM 分帧直传
 * 使用 ws 包（Node 18/20/22 行为一致，不依赖新版内置 WebSocket）
 */

const HOST = 'iat-api.xfyun.cn'
const FRAME_SIZE = 1280 // 讯飞要求每帧 1280 字节
// 非实时场景（整段录完再识别）无需模拟 40ms 实时节奏，小间隔快发即可
const FRAME_GAP = 4
// 总超时 = 基础10s + 音频时长余量（30s录音约3s发完，仍留足识别时间）
const io = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 WAV 中解析出 PCM 数据（兼容任意合法 RIFF chunk 顺序） */
function wavToPcm(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('音频格式错误：仅支持 WAV')
  }
  let off = 12
  let dataStart = -1
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      dataStart = off + 8
      return buf.subarray(dataStart, dataStart + size)
    }
    off += 8 + size + (size % 2) // chunk 按 2 字节对齐
  }
  if (dataStart < 0) throw new Error('WAV 中未找到音频数据')
}

/** 构造带鉴权签名的 WebSocket 地址 */
function buildAuthUrl(appId, apiKey, apiSecret) {
  const date = new Date().toUTCString()
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET /v2/iat HTTP/1.1`
  const signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64')
  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signature}"`
  const authorization = Buffer.from(authorizationOrigin).toString('base64')
  const q = (v) => encodeURIComponent(v)
  return `wss://${HOST}/v2/iat?authorization=${q(authorization)}&date=${q(date)}&host=${HOST}&appid=${q(appId)}`
}

/** 合并识别结果：按 sn 分段存储，动态修正时同 sn 覆盖，最终按序拼接 */
function mergeSegments(segMap) {
  return [...segMap.keys()].sort((a, b) => a - b).map((sn) => segMap.get(sn)).join('')
}

/**
 * 语音转文字
 * @param {Buffer} wav 16k 16bit 单声道 WAV
 * @returns {Promise<string>} 识别文本
 */
export function transcribe(wav) {
  const { appId, apiKey, apiSecret, enabled } = getAsr()
  if (!enabled) throw new Error('讯飞语音未配置完整')
  const pcm = wavToPcm(wav)

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildAuthUrl(appId, apiKey, apiSecret))
    const segments = new Map()
    let settled = false
    // 超时按音频时长动态放宽：发送耗时(帧数×间隔) + 识别余量8s，兜底15s起
    const sendMs = Math.ceil(pcm.length / FRAME_SIZE) * FRAME_GAP
    const timeoutMs = Math.max(15_000, sendMs + 8_000)
    const finish = (fn, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* 已关闭 */ }
      fn(val)
    }
    const timer = setTimeout(() => finish(reject, new Error(`语音识别超时（${Math.round(timeoutMs / 1000)}秒），请重试`)), timeoutMs)

    ws.on('open', async () => {
      // 首帧：带鉴权业务参数
      ws.send(JSON.stringify({
        common: { app_id: appId },
        business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin' },
        data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: pcm.subarray(0, FRAME_SIZE).toString('base64') },
      }))
      // 中间帧
      for (let off = FRAME_SIZE; off < pcm.length; off += FRAME_SIZE) {
        await io(FRAME_GAP)
        ws.send(JSON.stringify({
          data: { status: 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: pcm.subarray(off, off + FRAME_SIZE).toString('base64') },
        }))
      }
      // 结束帧（音频不足一帧时无中间帧，直接告知结束）
      await io(FRAME_GAP)
      ws.send(JSON.stringify({ data: { status: 2 } }))
    })

    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString())
        if (msg.code !== 0) {
          return finish(reject, new Error(`讯飞识别失败(${msg.code})：${msg.message || '服务异常'}`))
        }
        const result = msg.data?.result
        if (result) {
          const text = (result.ws || []).flatMap((w) => w.cw || []).map((c) => c.w).join('')
          segments.set(result.sn, text) // 同 sn 覆盖 = 动态修正
        }
        if (msg.data?.status === 2) finish(resolve, mergeSegments(segments))
      } catch { /* 忽略异常帧 */ }
    })

    ws.on('close', (code, reason) => {
      if (settled) return
      // 未收到结果即断开：401 为鉴权失败，其余按码透出
      if (segments.size) finish(resolve, mergeSegments(segments))
      else {
        const reasonStr = reason?.toString() || ''
        const hint = code === 1006 || reasonStr.includes('401')
          ? '鉴权失败，请检查 APPID/APIKey/APISecret'
          : `请检查凭据与网络(close=${code}${reasonStr ? ' ' + reasonStr : ''})`
        finish(reject, new Error(`讯飞连接关闭：${hint}`))
      }
    })
    // ws 包的 error 带具体错误（如 Unexpected server response: 401），其后必触发 close
    ws.on('error', (err) => {
      const detail = err?.message || ''
      if (settled || !detail) return
      finish(reject, new Error(`讯飞连接失败：${detail}`))
    })
  })
}
