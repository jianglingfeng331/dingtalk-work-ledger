import { createRouter, createWebHashHistory } from 'vue-router'
import WorkPage from '../views/WorkPage.vue'

// hash 模式：静态托管即可运行，钉钉内嵌浏览器刷新不 404
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'work',
      // 首屏静态打包：首进应用不再额外等待一次页面 chunk 网络请求（弱网下该窗口期即白屏）
      component: WorkPage,
      meta: { title: '工作记录' },
    },
    {
      path: '/quick',
      name: 'quick',
      component: () => import('../views/QuickFillPage.vue'),
      meta: { title: '快速填写' },
    },
    {
      path: '/settings-web',
      name: 'settingsWeb',
      component: () => import('../views/WebSettingsPage.vue'),
      meta: { title: '设置' },
    },
    {
      path: '/desktop-pair',
      name: 'desktopPair',
      component: () => import('../views/DesktopPairPage.vue'),
      meta: { title: '桌面端登录授权' },
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
