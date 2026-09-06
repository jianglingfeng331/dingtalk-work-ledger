---
name: "work-h5-desktop-ui"
description: "work-h5 钉钉台账项目的桌面端（电脑浏览器）页面/组件 UI 开发规范：px→vw 防放大适配清单、统一设计语言（毛玻璃顶栏/光晕背景/无边框面板/按钮体系/动效/空状态）。当用户要求在 web 端/电脑端/桌面端新增页面、改造页面为桌面布局、或为 /quick、/settings-web 等桌面路由加功能时调用。"
---

# work-h5 桌面端页面 UI 规范

适用于 `work-h5`（Vue3 + Vite + vant）中**电脑浏览器使用的页面与全局悬浮组件**。移动端页面（tabbar 路由）不适用本规范。

参考实现（改之前先读，照抄其结构与类名）：
- 表单型双栏页：`src/views/QuickFillPage.vue`
- 列表/管理型单栏页：`src/views/WebSettingsPage.vue`
- 全局悬浮组件：`src/components/AiAssistant.vue`

## 一、强制适配清单（漏一项页面就会出事故）

1. **vite px→vw 排除**：`vite.config.js` 中 `pxToViewport({ exclude: [...] })` 必须加入新文件正则，如 `/NewPage/`、`/NewComponent/`。
   - 原因：viewportWidth=375，1920px 屏上 1vw≈19px，14px 会被放大到 ~71px。
   - 验证：构建后 `grep -c vw dist/assets/<NewPage-*.css>` 必须为 0。
2. **App.vue 路由门控**：桌面页路由名加入 `isDesktopPage` 数组（`src/App.vue`），自动获得：
   - 隐藏移动端 van-tabbar；
   - body 切换 `quick-desktop` 类。
   - 全局悬浮组件用 `<Xxx v-if="isDesktopPage" />` 挂在 App.vue。
3. **body 类覆盖 vant 弹层**：Toast/Dialog/Loading 渲染到 body，其样式仍被转 vw。新用到的 vant 弹层样式在 `index.html` 的 `body.quick-desktop` 作用域内用固定 px 覆盖（参照已有 .van-toast/.van-dialog 段）。
4. **页面根节点**：`min-height: 100dvh`（回退 100vh）、`font-size: 14px`、`position: relative`、`font-variant-numeric: tabular-nums`。
5. **桌面交互禁用移动端弹层**：不用 van-popup/van-picker/van-stepper/van-field 做核心交互，一律原生 `select`（自定义 SVG 下拉箭头）、`input`、`textarea`、`button`。

## 二、设计语言（Design Tokens）

### 布局
- 内容容器与顶栏内层统一 `max-width: 1180px; margin: 0 auto; padding: 0 24px`（两页宽度必须一致）；主内容区 `padding: 28px 24px 44px`。
- 顶栏：`position: sticky; z-index: 20`，`background: rgba(255,255,255,0.78)` + `backdrop-filter: blur(14px) saturate(160%)`，底边 `1px solid rgba(23,43,77,0.08)`，高 56px。

### 背景与面板
- 页面底色 `#f6f7fa`；根节点 `::before`（position:fixed、pointer-events:none）双 radial 光晕：
  `radial-gradient(760px 380px at 88% -12%, rgba(22,119,255,.07), transparent 62%), radial-gradient(680px 340px at -8% 108%, rgba(10,165,109,.045), transparent 60%)`。
- 面板 `.panel`：**不用边框**，`background: rgba(255,255,255,.94)`、`border-radius: 16px`、`padding: 22px 26px 24px`，双层有色阴影：
  `0 1px 2px rgba(23,43,77,.04), 0 12px 32px -14px rgba(23,43,77,.12)`。
- 面板头：底分隔线 `1px solid #eef0f4`；标题 18px/650；副文案 12px `#8a94a3`。

### 色彩
- 主色 `#1677ff`（hover `#2b82ff`，深态文字 `#0e5fd8`）；成功 `#0aa56d`；琥珀 `#d97706`/`#b45309`；危险 `#d92d20`（底色 `#fef3f2`）。
- 文字层级：`#232b38` / `#1d2939` 标题 → `#475467` → `#667085` → `#8a94a3` → `#98a2b3` 占位/提示。
- 中性边：`#e3e8ef` / `#dde2ea` / `#eef0f4` / `#f6f8fb`。
- **禁止**蓝色线性渐变做 logo/按钮/气泡（AI 指纹）；品牌块用实色 `#1677ff` + `inset 0 -5px 8px rgba(0,45,110,.18)` 内阴影塑形。

### 按钮（.q-btn 体系）
- 基类：`height: 40px; padding: 0 24px; border-radius: 10px; border: none; transition: all .18s cubic-bezier(.2,.8,.3,1)`。
- `.q-btn-ghost`：白底 + `1px solid #e3e8ef` + 灰字，hover 变蓝边蓝字浅蓝底。
- `.q-btn-primary`：实色蓝 + 白字 600 + 轻投影；hover `translateY(-1px)` + 蓝色光晕阴影；`:active:not(:disabled) scale(.98)`。
- `.q-btn-danger`：白底 + `rgba(217,45,32,.28)` 边 + 红字，hover `#fef3f2`。
- `.q-btn-sm`：30px 高、12.5px 字、8px 圆角。
- 小图标按钮（如外链）：30×30 方框 ghost 风格，内含 12px SVG。

### 表单控件
- select/input/textarea：`border: 1px solid #dde2ea; border-radius: 10px`，select/input 高 40px；hover 边 `#b9c2d0`；focus 去 outline、蓝边 + `box-shadow: 0 0 0 3px rgba(22,119,255,.14)`。
- label：13.5px/550、`#475467`、右对齐、line-height 40px；窄屏（≤720px）改左对齐顶置。
- 分段单选：`.seg-group` 灰底胶囊（`#eef1f5`、11px 圆角、3px padding），`.seg-item.active` 白底 + 轻阴影 + 600 字重。
- 预设 chip：999px 圆角胶囊，on 态浅蓝底蓝边；active scale(.94)。
- 提示文案：12px `#98a2b3`；快捷键用 `<kbd>`（白底、`#d5dae2` 边、等宽字体）。

### 状态与徽标
- tag/徽标统一 999px 胶囊、11px、600 字重、语义色 10~12% 透明度底色。
- 空状态：居中、SVG 线性图标（stroke `#c9d2de`/`#c9cfd8`、stroke-width 2）+ 标题 13.5px/600 `#667085` + 副文案 12px `#98a2b3`，上下 padding 约 26~30px。
- 列表行：不用分隔线堆叠，用行 hover `#f6f8fb` 底 + 10px 圆角；待审核等特殊行用琥珀 5% 底。

### 动效
- 入场：`@keyframes panel-rise { from { opacity:0; transform: translateY(10px) } to { opacity:1; transform:none } }`，`0.45s cubic-bezier(0.16,1,0.3,1) both`，多面板交错延迟 0.08s。
- 弹层用 Transition（transform/opacity，如 `translateY(14px) scale(.94)` → 正常，transform-origin bottom right）。
- 必须有 `@media (prefers-reduced-motion: reduce)` 关闭动画。
- 动画只用 transform/opacity（GPU 友好）。

### 可达性
- 全局 `:where(button, a):focus-visible { outline: 2px solid rgba(22,119,255,.55); outline-offset: 2px; border-radius: 8px }`。
- 装饰性 SVG/图片加 `aria-hidden="true"`；图标按钮加 `aria-label`。
- 所有可点元素有 hover 与 active（scale .94~.98）两态反馈。

## 三、AI 助手类悬浮组件

- 固定定位（`position: fixed`，右下 `right: 26px; bottom: 14px; z-index: 50`）；vite exclude 同样要覆盖组件文件名。
- 图片资源放 `src/assets/`，透明底 PNG 用 `filter: drop-shadow(...)` 而非 box-shadow；人物可有 idle 呼吸浮动（translateY ±5px，4s 循环）。
- 聊天面板复用移动端链路：`aiQuery(question)`（后端 MCP + LLM）、`getSettings().settings.suggestions` 快捷提问；Enter 发送 / Shift+Enter 换行；三点 loading；消息后自动滚底。

## 四、部署与验证

1. 部署：`cd work-h5 && bash scripts/deploy.sh`（构建 + rsync 增量同步 + 线上 bundle 自检；勿加 --delete，旧哈希资源需保留防缓存白屏）。
2. 验证：
   - 构建产物中新页面/组件 CSS `grep -c 'vw'` 为 0；
   - `ssh root@101.37.210.127 "ls /opt/workapp-git/work-h5/dist/assets/ | grep <标识>"` 确认线上资源；
   - 提示用户强刷（Cmd+Shift+R）验证。
3. **同一文件多处编辑必须串行**（一次 Edit 调用等返回后再发下一次），或编辑后 Grep 验证所有标记均存活——并行编辑同一文件会互相覆盖。
