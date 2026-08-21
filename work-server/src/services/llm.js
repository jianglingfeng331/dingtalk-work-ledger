import axios from 'axios'
import { getAI } from './settings.js'

/**
 * LLM 服务（OpenAI 兼容协议）
 * 支持提供商：智谱GLM（默认）/ 通义千问，均走 /chat/completions
 * 连接参数取自动态配置（设置页可改，立即生效）；10秒超时熔断
 */
const AI_TIMEOUT_MS = 15_000

export class AiTimeoutError extends Error {
  constructor() {
    super('AI 查询超时')
    this.name = 'AiTimeoutError'
  }
}

/**
 * LLM 对话（429/限流自动重试，指数退避）
 * @param {Array<{role:string,content:string}>} messages
 */
const RETRYABLE = new Set([429, 1305]) // 429=限流 1305=模型过载

/** 智谱免费模型兜底链：主力过载时切备用免费款 */
function zhipuFallbackModel(model) {
  return model === 'glm-4-flash-250414' ? 'glm-4.7-flash' : 'glm-4-flash-250414'
}

export async function chat(messages, { budgetMs = 50_000 } = {}) {
  const start = Date.now()
  const remain = () => budgetMs - (Date.now() - start)
  const ai = getAI()
  const models = ai.provider === 'zhipu' ? [ai.model, zhipuFallbackModel(ai.model)] : [ai.model]
  for (const model of models) {
    // 总预算耗尽直接熔断（调用方自行降级），避免重试链无限拉长前端等待
    if (remain() <= 2_000) throw new AiTimeoutError()
    try {
      return await chatOnce(ai, model, messages, remain())
    } catch (err) {
      // 限流或超时均切换备用模型，其余直接抛出
      const rate = RETRYABLE.has(err?.response?.status) || RETRYABLE.has(err?.response?.data?.error?.code)
      const timeout = err instanceof AiTimeoutError
      if (model !== models[models.length - 1] && (rate || timeout)) {
        console.warn(`[llm] 模型 ${model} ${timeout ? '超时' : '持续限流'}，切换备用模型...`)
        continue
      }
      throw err
    }
  }
}

/** 单模型调用（含429指数退避重试）；budgetMs=总预算剩余量，单次超时与退避均不超预算 */
async function chatOnce(ai, model, messages, budgetMs = AI_TIMEOUT_MS) {
  const delays = [0, 2000, 4000] // 首次 + 2次重试
  const start = Date.now()
  const remain = () => budgetMs - (Date.now() - start)

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]))
    // 剩余预算不足一次有效请求时熔断，避免前端等待被无限拉长
    if (remain() <= 2_000) throw new AiTimeoutError()
    const timeoutMs = Math.min(AI_TIMEOUT_MS, remain())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const { data } = await axios.post(
        `${ai.baseUrl}/chat/completions`,
        {
          model,
          temperature: 0.3,
          messages,
          // 智谱 GLM-4.5+ 默认深度思考（响应15s+），台账场景关闭思考提速
          ...(ai.provider === 'zhipu' ? { thinking: { type: 'disabled' } } : {}),
        },
        {
          headers: { Authorization: `Bearer ${ai.apiKey}` },
          timeout: timeoutMs,
          signal: controller.signal,
        },
      )
      return data?.choices?.[0]?.message?.content || ''
    } catch (err) {
      const aborted = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || controller.signal.aborted
      if (aborted) throw new AiTimeoutError()
      const code = err?.response?.status
      const subCode = err?.response?.data?.error?.code
      if ((code && RETRYABLE.has(code)) || (subCode && RETRYABLE.has(subCode))) {
        if (attempt < delays.length - 1) {
          console.warn(`[llm] 限流(${code}/${subCode})，第${attempt + 1}次重试...`)
          continue
        }
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('LLM 调用失败')
}

/**
 * 语音转写（智谱 GLM-ASR，OpenAI 兼容 multipart 接口）
 * @param {Buffer} audio 音频文件二进制（前端统一转 16k 单声道 WAV）
 * @param {string} filename
 */
export async function transcribe(audio, filename = 'speech.wav') {
  const ai = getAI()
  if (!ai.enabled) throw new Error('语音识别需要在设置页配置并启用 AI（智谱API Key）')

  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/wav' }), filename)
  form.append('model', 'glm-asr')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${ai.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.apiKey}` },
      body: form,
      signal: controller.signal,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${res.status}`
      throw new Error(`语音识别失败: ${msg}`)
    }
    return (data?.text || '').trim()
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('语音识别超时，请重试')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** AI 助手系统提示词：限定只基于台账数据回答 */
export function systemPrompt() {
  return [
    '你是「项目工作台账」的 AI 助手，负责帮团队成员查询、统计、复盘工作记录与任务安排。',
    '可用数据：工作日志（记录人/内容/工时/完成情况/关联任务）、任务表（任务名/负责人/状态/计划节点/任务分类）、项目成员（姓名/角色）。',
    '规则：',
    '1. 只基于下方提供的数据回答，数据中没有的信息不要编造；',
    '2. 用简洁中文回答，可使用简单排版（列表/短段落）；',
    '3. 涉及统计时给出具体数字（含工时可汇总）；',
    '4. 查任务进度/负责人/计划节点时优先用任务表数据，查做了什么/耗时用日志数据；',
    '5. 如果问题超出项目数据范围，友好引导用户回到工作数据相关提问。',
  ].join('\n')
}
