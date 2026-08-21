import { Router } from 'express'
import { get as getSettings, getAI, getTable, getAsr, update, AI_PROVIDERS } from '../services/settings.js'
import { config } from '../config.js'
import { listAllRecords as fetchTableRecords, listTasks as fetchTasks } from '../services/dingtalk-table.js'
import { asyncRoute, fail, ok } from '../utils/respond.js'

const router = Router()

/** 配置脱敏：API KEY 只回显尾4位 */
function maskKey(key) {
  if (!key) return ''
  return key.length <= 8 ? '****' : key.slice(0, 4) + '****' + key.slice(-4)
}

/**
 * GET /api/settings 读取系统配置与运行状态（登录即可读，用于前端动态渲染）
 */
router.get(
  '/settings',
  asyncRoute(async (req, res) => {
    const s = getSettings()
    const ai = getAI()
    const asr = getAsr()
    ok(res, {
      settings: {
        tags: s.tags,
        suggestions: s.suggestions,
        dedupWindowSec: s.dedupWindowSec,
        adminUserIds: s.adminUserIds,
        ai: {
          enabled: s.ai.enabled,
          provider: s.ai.provider,
          model: s.ai.model,
          baseUrl: s.ai.baseUrl,
          apiKeyMasked: maskKey(ai.apiKey),
        },
        asr: {
          appId: s.asr.appId,
          apiKeyMasked: maskKey(asr.apiKey),
          apiSecretMasked: maskKey(asr.apiSecret),
          enabled: asr.enabled,
        },
      },
      providers: Object.entries(AI_PROVIDERS).map(([key, p]) => ({
        key,
        label: p.label,
        baseUrl: p.baseUrl,
        defaultModel: p.model,
        models: p.models,
        keyUrl: p.keyUrl,
      })),
      runtime: {
        dingtalk: config.dingtalkEnabled,
        table: getTable().enabled,
        ai: ai.enabled,
        isAdmin: req.user.isAdmin,
      },
    })
  }),
)

/**
 * PUT /api/settings 更新系统配置（仅管理员，改完即生效并落盘）
 * 约定：ai.apiKey 传空字符串表示保持不变
 */
router.put(
  '/settings',
  asyncRoute(async (req, res) => {
    if (!req.user.isAdmin) return fail(res, '仅管理员可修改系统配置', 403)

    const b = req.body || {}
    const patch = {}

    if (Array.isArray(b.tags)) patch.tags = b.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 50)
    if (Array.isArray(b.suggestions))
      patch.suggestions = b.suggestions.map((t) => String(t).trim()).filter(Boolean).slice(0, 10)
    if (Array.isArray(b.adminUserIds))
      patch.adminUserIds = b.adminUserIds.map((t) => String(t).trim()).filter(Boolean)
    if (Number.isFinite(Number(b.dedupWindowSec)))
      patch.dedupWindowSec = Math.min(Math.max(Number(b.dedupWindowSec) || 60, 0), 3600)

    if (b.ai && typeof b.ai === 'object') {
      patch.ai = {}
      // 切换提供商时套用该提供商的默认模型与 baseUrl
      if (b.ai.provider && AI_PROVIDERS[b.ai.provider]) {
        patch.ai.provider = b.ai.provider
        if (!b.ai.model) {
          patch.ai.model = AI_PROVIDERS[b.ai.provider].model
          patch.ai.baseUrl = AI_PROVIDERS[b.ai.provider].baseUrl
        }
      }
      if (typeof b.ai.enabled === 'boolean') patch.ai.enabled = b.ai.enabled
      if (b.ai.model) patch.ai.model = String(b.ai.model)
      if (b.ai.baseUrl) patch.ai.baseUrl = String(b.ai.baseUrl)
      if (typeof b.ai.apiKey === 'string' && b.ai.apiKey) patch.ai.apiKey = b.ai.apiKey.trim()
    }

    if (b.table && typeof b.table === 'object') {
      // 兼容旧前端残留的 table 段：忽略（表格配置已迁移至项目管理 /api/projects）
    }

    // 讯飞语音：appId 明文可改；Key/Secret 留空表示保持不变
    if (b.asr && typeof b.asr === 'object') {
      const cur = getSettings().asr
      patch.asr = {
        appId: b.asr.appId !== undefined ? String(b.asr.appId).trim() : cur.appId,
        apiKey: b.asr.apiKey ? String(b.asr.apiKey).trim() : cur.apiKey,
        apiSecret: b.asr.apiSecret ? String(b.asr.apiSecret).trim() : cur.apiSecret,
      }
    }

    update(patch)
    ok(res, getSettings(), '配置已更新并生效')
  }),
)

export default router
