import axios from 'axios'
import { getAI } from './settings.js'

/**
 * LLM 服务（OpenAI 兼容协议）
 * 支持提供商：智谱GLM（默认）/ 通义千问，均走 /chat/completions
 * 连接参数取自动态配置（设置页可改，立即生效）；10秒超时熔断
 */
const AI_TIMEOUT_MS = 22_000

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

export async function chat(messages, { budgetMs = 75_000 } = {}) {
  const start = Date.now()
  const remain = () => budgetMs - (Date.now() - start)
  const ai = getAI()
  const models = ai.provider === 'zhipu' ? [ai.model, zhipuFallbackModel(ai.model)] : [ai.model]
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi]
    // 总预算耗尽直接熔断（调用方自行降级），避免重试链无限拉长前端等待
    if (remain() <= 2_000) throw new AiTimeoutError()
    // 主力模型给足重试次数（免费模型高峰偶发慢/限流，重试常能成功）；
    // 备用模型仅快速试一次（长期拥塞的备用模型不值得消耗预算）
    const attempts = mi === 0 ? 3 : 1
    try {
      return await chatOnce(ai, model, messages, remain(), attempts)
    } catch (err) {
      // 限流、超时或连续空内容均切换备用模型，其余直接抛出
      const rate = RETRYABLE.has(err?.response?.status) || RETRYABLE.has(err?.response?.data?.error?.code)
      const timeout = err instanceof AiTimeoutError
      const empty = /空内容/.test(String(err?.message || ''))
      if (mi < models.length - 1 && (rate || timeout || empty)) {
        console.warn(`[llm] 模型 ${model} ${timeout ? '超时' : rate ? '持续限流' : '返回空内容'}，切换备用模型...`)
        continue
      }
      throw err
    }
  }
}

/**
 * 单模型调用（429/超时/空内容均指数退避重试）
 * @param {number} budgetMs 总预算剩余量，单次超时与退避均不超预算
 * @param {number} attempts 最大尝试次数（主力3次，备用1次快速失败）
 */
async function chatOnce(ai, model, messages, budgetMs = AI_TIMEOUT_MS, attempts = 3) {
  const delays = Array.from({ length: attempts }, (_, i) => (i === 0 ? 0 : i === 1 ? 2000 : 4000))
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
      const content = String(data?.choices?.[0]?.message?.content || '').trim()
      if (content) return content
      // HTTP 200 但内容为空（限流时段偶发）：按可重试错误处理，重试耗尽抛明确错误
      if (attempt < delays.length - 1) {
        console.warn(`[llm] 模型 ${model} 返回空内容，重试...`)
        continue
      }
      throw new Error('模型连续返回空内容')
    } catch (err) {
      const aborted = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || controller.signal.aborted
      if (aborted) {
        // 超时：预算内仍有重试次数则重试（免费模型高峰偶发慢，第二次常能成功）；否则熔断
        if (attempt < delays.length - 1 && remain() > 3_000) {
          console.warn(`[llm] 模型 ${model} 响应超时(${Math.round(timeoutMs / 1000)}s)，重试...`)
          continue
        }
        throw new AiTimeoutError()
      }
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
 * LLM 流式对话：模型边生成边通过 onToken(delta, full) 推送增量文本
 * 模型轮转/限流重试与 chat() 一致，但重试只发生在「首 token 到达前」；
 * 一旦开始出字，后续中断不再重试（避免重复输出），返回已累积文本。
 * @param {Array<{role:string,content:string}>} messages
 * @param {{onToken?:(delta:string,full:string)=>void, budgetMs?:number}} opts
 * @returns {Promise<string>} 完整回答文本
 */
export async function chatStream(messages, { onToken, budgetMs = 75_000 } = {}) {
  const start = Date.now()
  const remain = () => budgetMs - (Date.now() - start)
  const ai = getAI()
  const models = ai.provider === 'zhipu' ? [ai.model, zhipuFallbackModel(ai.model)] : [ai.model]

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi]
    if (remain() <= 2_000) throw new AiTimeoutError()
    // 主力首字前失败重试3次；备用仅快速试1次
    const attempts = mi === 0 ? 3 : 1
    const delays = Array.from({ length: attempts }, (_, i) => (i === 0 ? 0 : i === 1 ? 1500 : 3000))
    const deadline = Date.now() + remain() // 绝对截止：防上游发心跳字节但永不出正文导致流无限挂起
    let exhausted = false
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]))
      if (remain() <= 2_000) throw new AiTimeoutError()
      try {
        const text = await streamOnce(ai, model, messages, {
          onToken,
          timeoutMs: Math.min(AI_TIMEOUT_MS, remain()),
          deadline,
        })
        if (text) return text
        // 首字前结束且无内容：限流时段偶发，重试
        if (attempt < delays.length - 1) {
          console.warn(`[llm] 流式 ${model} 返回空，第${attempt + 1}次重试...`)
          continue
        }
        exhausted = true
      } catch (err) {
        const rate = RETRYABLE.has(err?.response?.status) || RETRYABLE.has(err?.response?.data?.error?.code)
        const timeout = err instanceof AiTimeoutError
        if (attempt < delays.length - 1 && (rate || timeout)) {
          console.warn(`[llm] 流式 ${model} ${timeout ? '超时' : '限流'}，第${attempt + 1}次重试...`)
          continue
        }
        // 非限流/超时错误（如 401 key 无效）直接抛出，不必切模型
        if (!rate && !timeout) throw err
        exhausted = true
      }
    }
    if (exhausted && mi < models.length - 1) {
      console.warn(`[llm] 流式模型 ${model} 首字前失败，切换备用模型...`)
      continue
    }
    if (mi >= models.length - 1) throw new AiTimeoutError()
  }
  throw new Error('LLM 流式调用失败')
}

/** 单次流式请求，解析 SSE 增量；首字前出错 reject，出字后中断 resolve 已累积文本 */
function streamOnce(ai, model, messages, { onToken, timeoutMs, deadline = Infinity }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let watchdog = null
    let acc = ''
    let gotToken = false
    let buf = ''
    let settled = false
    // 看门狗：每收到数据就重置；deadline 为绝对截止（兜底心跳字节导致的假活流）
    const arm = () => {
      clearTimeout(watchdog)
      const left = Math.min(timeoutMs, deadline - Date.now())
      if (left <= 0) {
        controller.abort()
        return
      }
      watchdog = setTimeout(() => controller.abort(), left)
    }
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      fn(arg)
    }
    arm()
    axios
      .post(
        `${ai.baseUrl}/chat/completions`,
        {
          model,
          temperature: 0.3,
          messages,
          stream: true,
          ...(ai.provider === 'zhipu' ? { thinking: { type: 'disabled' } } : {}),
        },
        {
          headers: { Authorization: `Bearer ${ai.apiKey}`, Accept: 'text/event-stream' },
          responseType: 'stream',
          signal: controller.signal,
        },
      )
      .then((res) => {
        const stream = res.data
        stream.on('data', (chunk) => {
          arm()
          buf += chunk.toString()
          let idx
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const j = JSON.parse(payload)
              const delta = j.choices?.[0]?.delta?.content || ''
              if (delta) {
                gotToken = true
                acc += delta
                try {
                  onToken?.(delta, acc)
                } catch {
                  /* 回调异常不影响流 */
                }
              }
            } catch {
              /* 跨行的不完整 JSON 片段，忽略 */
            }
          }
        })
        stream.on('end', () => finish(resolve, acc))
        stream.on('error', (err) => {
          // 已出字则保留部分结果（前端已逐字显示），否则按失败处理以触发重试
          if (gotToken) finish(resolve, acc)
          else finish(reject, err)
        })
      })
      .catch((err) => {
        const aborted = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || controller.signal.aborted
        if (aborted) finish(reject, new AiTimeoutError())
        else finish(reject, err) // 429/401 等 HTTP 错误：err.response.status 供上层判断
      })
  })
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
    '2. 用简洁中文回答，可使用简单排版（列表/短段落）；输出纯文本，禁止使用任何 Markdown 标记（如 * ** # `），列表用「1.」或「-」开头；',
    '3. 涉及统计时给出具体数字（含工时可汇总）；',
    '4. 区分两类核心数据：「任务表」= 工作安排/计划（有负责人/状态/计划节点），「工作日志」= 已完成的工作流水（有记录人/工时）；',
    '5. 用户问「XX名下的任务/负责的任务/XX的任务」「未完成/进行中的任务」「计划节点」「任务分类」「任务安排/进度」等任务类问题时，只依据【任务表】（和【领导指令】）作答，禁止引用【工作日志】的任何条目或数字（若上下文未提供日志段，也不要提及日志）；不要拿日志记录充当任务；',
    '6. 用户问「XX做了什么/工时/工作内容」时用【工作日志】段落；',
    '7. 输出以汇总统计为主：默认先给结论、关键数字和简要归类（如按人/按状态/按分类小计），不要默认罗列大段明细；只有当用户明确提出要看明细（如「明细」「逐条」「列出每条」「具体内容」）时才逐条展示，且明细超过10条时先说明总数、再列前10条并注明其余可追问；',
    '8. 周报文体：用户要求「周报」「写周报/生成周报/汇报/总结汇报」时，输出组织成段落式的周报文章（可直接粘贴使用），不要把任务和日志逐条罗列：开头一段总述本周整体推进情况、重点成果与总体工时（从工作日志汇总工时数字；若日志无数据则不提工时）；主体每段围绕一块工作连贯叙述（工作内容、责任人、进展数字自然融入句子）；结尾一小段谈风险/下周重点；除必要外不用列表符号，条目间用自然语言衔接；已取消的任务在周报中一律不提（包括风险段也不要拿取消任务说事）；',
    '9. 如果问题超出项目数据范围，友好引导用户回到工作数据相关提问。',
  ].join('\n')
}
