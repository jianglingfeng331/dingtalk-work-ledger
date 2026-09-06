import { reactive } from 'vue'

/**
 * 全局项目状态：多项目隔离（每人涉及的项目不同，切换后日志/计划推到对应项目）
 * - 列表来自后端 /projects：平台全部项目；普通用户每项附 member 标识（yes/no/unknown）
 * - member === 'no' 的项目仅展示不可切换（数据访问由服务端 projectGuard 拦截）
 * - 当前项目存 localStorage，请求拦截器统一带 x-project-id 头
 */
export const projectStore = reactive({
  projectId: localStorage.getItem('work_project_id') || '',
  projects: [], // [{id, name, baseId, sheetId, member?, isLeader?}]
  loaded: false,
})

/** 该项目当前用户是否可用（可切换）：非成员(no)不可用，unknown/未标注(管理员)视为可用 */
export function isJoined(p) {
  return !p || p.member !== 'no'
}

export function setCurrentProject(id) {
  projectStore.projectId = id || ''
  if (id) localStorage.setItem('work_project_id', id)
  else localStorage.removeItem('work_project_id')
}

/** 拉取项目列表并校正当前选中项（不在列表或已非成员时回落首个成员项目）
 * 登录后、各页面挂载时均会调用：已加载过则直接返回（登录流程那次为准），force 可强制刷新 */
let loadingPromise = null
export function loadMyProjects({ force = false } = {}) {
  if (projectStore.loaded && !force) return Promise.resolve(projectStore.projects)
  if (loadingPromise && !force) return loadingPromise
  loadingPromise = (async () => {
    try {
      const { getProjects } = await import('../api')
      const res = await getProjects()
      projectStore.projects = res?.projects || []
      fixCurrentProject()
      projectStore.loaded = true
    } catch (err) {
      // 拉取失败不缓存空列表（loaded 保持 false）：下次进页面自动重试。
      // 否则一旦失败（如启动期登录竞态/网络抖动），整个会话都没有项目ID，业务接口全400 → 页面挂"演示"标签
      projectStore.projects = []
      console.warn('[project] 项目列表拉取失败，稍后自动重试:', err?.message)
    } finally {
      loadingPromise = null
    }
    return projectStore.projects
  })()
  return loadingPromise
}

/** 校正当前项目：未选中/已不在列表/已是非成员(no)时，回落到首个成员项目 */
export function fixCurrentProject() {
  const cur = projectStore.projects.find((p) => p.id === projectStore.projectId)
  if (cur && isJoined(cur)) return
  setCurrentProject(projectStore.projects.find((p) => isJoined(p))?.id || '')
}

/** 当前项目名（未拉到列表时兜底空串） */
export function currentProject() {
  return projectStore.projects.find((p) => p.id === projectStore.projectId) || null
}
