import { reactive } from 'vue'

/**
 * 全局项目状态：多项目隔离（每人涉及的项目不同，切换后日志/计划推到对应项目）
 * - 列表来自后端 /projects：管理员=全部项目；普通成员=以各项目AI表格「项目成员表」为准
 * - 当前项目存 localStorage，请求拦截器统一带 x-project-id 头
 */
export const projectStore = reactive({
  projectId: localStorage.getItem('work_project_id') || '',
  projects: [], // [{id, name, baseId, sheetId, ...}]
  loaded: false,
})

export function setCurrentProject(id) {
  projectStore.projectId = id || ''
  if (id) localStorage.setItem('work_project_id', id)
  else localStorage.removeItem('work_project_id')
}

/** 拉取"我的项目"列表并校正当前选中项（不在列表时回落第一项）
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
      if (!projectStore.projects.some((p) => p.id === projectStore.projectId)) {
        setCurrentProject(projectStore.projects[0]?.id || '')
      }
    } catch {
      projectStore.projects = []
    } finally {
      projectStore.loaded = true
      loadingPromise = null
    }
    return projectStore.projects
  })()
  return loadingPromise
}

/** 当前项目名（未拉到列表时兜底空串） */
export function currentProject() {
  return projectStore.projects.find((p) => p.id === projectStore.projectId) || null
}
