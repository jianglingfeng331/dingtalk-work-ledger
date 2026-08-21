import { createRouter, createWebHashHistory } from 'vue-router'

// hash 模式：静态托管即可运行，钉钉内嵌浏览器刷新不 404
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'work',
      component: () => import('../views/WorkPage.vue'),
      meta: { title: '工作记录' },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: () => import('../views/TasksPage.vue'),
      meta: { title: '任务' },
    },
    {
      path: '/ai',
      name: 'ai',
      component: () => import('../views/AIQueryPage.vue'),
      meta: { title: 'AI 查询' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/SettingsPage.vue'),
      meta: { title: '系统设置' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · 项目工作台账` : '项目工作台账'
})

export default router
