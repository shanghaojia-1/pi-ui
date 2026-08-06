# Pi Studio 主题开发规范

本文是 Pi Studio 新主题的实现与验收标准，主要供后续 AI 编程代理使用。开始主题任务前，应先阅读本文，再检查现有代码和用户提供的素材；不要只照抄某个旧主题的颜色。

## 1. 目标与基本原则

一个完整主题应当形成统一的产品视觉语言，而不是“换一张背景图、替换几个颜色”。主题至少需要同时覆盖：

- 全局色彩、文字层级、边框、圆角、阴影和焦点状态；
- 主背景、左右侧栏、顶部栏、会话列表和状态栏；
- 双方消息、头像、Markdown、代码块、思考过程和工具调用；
- 输入区、按钮、选择器、菜单和审批状态；
- 欢迎页、建议按钮、设置页、统计弹窗、右侧详情面板和图片灯箱；
- 启动页，包括主题背景、信息卡片、加载状态和主题标语。

主题设计须服从可用性。人物主体、文字可读性、对话空间和控件层级比装饰效果优先。

## 2. 不可破坏的交互与布局契约

除非用户明确要求改变产品布局，否则新主题必须遵守以下规则：

1. 不压缩对话空间。`.msg` 的基础 `max-width: 780px`、居中方式和可用宽度应保留；不得为了露出背景人物而把整个对话区挤到半边。
2. 背景必须铺满可视区域，不得出现黑边、空白边或图片只显示一部分的问题。优先使用经过构图处理的横向主题图，再使用 `background-size: cover`。
3. 用图片构图和可读性渐变保护人物主体，不要通过移动主要功能区来避让人物。宽屏启动页的信息卡可放在素材的安全留白区；窄屏应提供不依赖人物位置的降级背景。
4. 顶部选择菜单和斜杠菜单必须始终位于消息气泡之上。不得降低基础 `.select-menu`、`.slash-menu` 的层级，也不要给消息区域创建更高的无必要 stacking context。
5. 输入区只有一个视觉外框。主题可以修改 `.composer-box` 的边框、背景和阴影，但 `.composer-input` 应保持透明、无独立边框和无独立阴影；不得用伪元素制造第二层框。
6. 用户和 Agent 两侧都必须显示头像。Agent 使用当前主题的 `avatar`；没有主题头像时保留 π 回退。头像按钮必须可点击并通过灯箱查看大图。
7. 保留键盘焦点、悬停、禁用、运行、错误和审批等状态；不能只设计静态截图。
8. 不用低对比度透明层强行展示背景。正文、代码和表单在正常亮度显示器上必须清楚可读。

## 3. 代码架构与文件位置

主题系统的主要入口如下：

| 文件 | 职责 |
| --- | --- |
| `src/renderer/src/lib/theme.tsx` | `ThemeId`、设计令牌、主题目录、图片与头像注册、CSS 变量注入 |
| `src/renderer/src/lib/i18n.tsx` | 主题名称和副标题的中英文文案 |
| `src/renderer/src/styles.css` | 基础组件样式和各主题的完整组件级覆盖 |
| `src/renderer/src/assets/` | 原图、处理后的横向背景和方形头像 |
| `tests/unit/i18n.test.ts` | 主题目录、翻译、素材和主题属性测试 |
| `tests/e2e/i18n-theme.spec.ts` | 设置页主题数量、切换、CSS 变量和持久化测试 |

`THEMES` 是主题元数据的单一事实来源。设置页缩略图、主题切换、启动页标语和 Agent 头像都会从这里读取，不应在组件中另建主题名单。

## 4. 命名规范

新主题先确定一个稳定的 kebab-case 标识，例如 `sample-theme`。相关名称统一如下：

- `ThemeId`：`'sample-theme'`
- 令牌常量：`SAMPLE_THEME`
- 翻译键：`settings.theme.sampleTheme`、`settings.theme.sampleThemeHint`
- CSS 根选择器：`html[data-theme='sample-theme']`
- 素材：`sample-theme-original.png`、`sample-theme-theme.png`、`sample-theme-avatar.png`

不要用显示名称作为持久化标识，也不要在发布后随意更改 `ThemeId`，因为该值会存入 `localStorage` 的 `pi-studio-theme`。

## 5. 图片素材规范

### 5.1 必备素材

人物主题通常保留三份文件：

- `*-original.*`：用户提供的原始素材，作为可追溯源文件，不在运行时代码中引用；
- `*-theme.png`：应用主背景和启动页使用的横向构图；
- `*-avatar.png`：Agent 消息头像使用的方形裁切。

运行时只导入 `*-theme.png` 和 `*-avatar.png`。如果仓库体积成为问题，可在得到用户同意后不提交原图，但不得覆盖唯一原始文件。

### 5.2 背景构图

推荐背景比例为 16:9，基准尺寸为 1792×1024 或 1920×1080。应根据产品布局安排安全区域：

- 人物在右侧时，左侧保留低细节区域供启动卡片和主要文字使用；
- 人物在左侧时反向处理；
- 人脸、手部和关键姿势不能位于常见窗口裁切边缘；
- 用延展画布、渐变、模糊背景或自然环境补全横图，避免简单拉伸人物；
- `cover` 裁切后仍应完整显示人物关键部位，至少检查 16:9、4:3 和约 1000px 宽窗口。

若用户要求保留原图人物，必须使用非生成式处理：裁切、缩放、画布延展、色彩校正、轻度降噪和锐化。不得重绘人物，不得改变身份、脸部、衣着、动作、手势或身体比例。生成式修改只有在用户明确要求且内容允许时才可进行。

处理素材时应保留纵横比，不要放大低分辨率图片到明显失真。避免过度磨皮、过饱和、明显锐化光圈和不可逆地覆盖原图。

### 5.3 头像裁切

头像推荐至少 256×256：

- 以脸部为视觉中心，适当保留发型或具有辨识度的配饰；
- 先从原图直接裁切，再缩放，不从已加渐变的主题横图二次裁切；
- 在 32–34px 的实际显示尺寸下仍应能辨认；
- 通过 `avatarPosition` 微调圆形框中的位置；
- 点击后的灯箱大图不能糊成色块。

### 5.4 素材验收

处理后必须实际打开查看背景和头像，不能只相信命令成功。检查：黑边、拼接缝、错误裁切、人物变形、色带、透明通道异常以及文件体积。正式构建还应确认原图没有被意外打入渲染产物。

## 6. 注册主题

### 6.1 导入素材并扩展类型

在 `theme.tsx` 顶部导入运行时素材，并把标识加入 `ThemeId`：

```tsx
import sampleThemeAvatar from '../assets/sample-theme-avatar.png'
import sampleThemeArtwork from '../assets/sample-theme-theme.png'

export type ThemeId =
  | 'system'
  | 'light'
  // ...已有主题
  | 'sample-theme'
```

### 6.2 定义完整设计令牌

每个主题必须提供全部 `ThemeVariable`，不能依赖上一个主题遗留的行内变量：

```tsx
const SAMPLE_THEME: ThemeVariables = {
  '--bg': '#...',
  '--bg-panel': '#...',
  '--bg-elevated': '#...',
  '--bg-subtle': '#...',
  '--bg-hover': '#...',
  '--bg-active': '#...',
  '--border': '#...',
  '--border-strong': '#...',
  '--text': '#...',
  '--text-2': '#...',
  '--text-3': '#...',
  '--text-3-strong': '#...',
  '--accent': '#...',
  '--accent-strong': '#...',
  '--accent-soft': '#...',
  '--green': '#...',
  '--green-soft': '#...',
  '--red': '#...',
  '--red-soft': '#...',
  '--amber': '#...',
  '--amber-soft': '#...',
  '--blue': '#...',
  '--blue-soft': '#...',
}
```

语义约定：`--text*` 是正文层级，`--accent*` 是品牌和主要动作，green/red/amber/blue 用于成功、错误、警告和信息状态。状态色必须保持语义，不应为了统一配色把错误状态也改成主题强调色。

### 6.3 添加目录项

在 `THEMES` 末尾增加定义：

```tsx
{
  id: 'sample-theme',
  labelKey: 'settings.theme.sampleTheme',
  hintKey: 'settings.theme.sampleThemeHint',
  swatch: 'linear-gradient(135deg, #... 0%, #... 100%)',
  colorScheme: 'light',
  variables: SAMPLE_THEME,
  artwork: sampleThemeArtwork,
  artworkPosition: 'right center',
  artworkOpacity: 1,
  avatar: sampleThemeAvatar,
  avatarPosition: 'center 34%',
  quote: 'Theme signature · Pi Agent',
},
```

字段说明：

- `swatch`：无图片时的主题色预览；人物主题设置页会直接用 `artwork` 作为缩略图；
- `colorScheme`：影响原生控件和浏览器颜色方案，必须与整体明暗一致；
- `artworkPosition`：主背景及设置缩略图的默认焦点；
- `artworkOpacity`：全局装饰图透明度，完整背景通常为 `1`；
- `avatarPosition`：头像的 `background-position`；
- `quote`：启动页底部主题标语。

### 6.4 添加双语文案

在 `i18n.tsx` 的主题区加入中英文名称和副标题：

```tsx
'settings.theme.sampleTheme': { zh: '示例主题', en: 'Sample Theme' },
'settings.theme.sampleThemeHint': { zh: '视觉关键词 A · 关键词 B', en: 'Keyword A · keyword B' },
```

名称应简短明确；副标题描述视觉风格或主题精神，不要把内部实现信息写给用户。

## 7. 组件级视觉覆盖

所有专属 CSS 必须放在 `styles.css` 中一个连续、带标题的区块里，并使用以下形式严格限定作用域：

```css
/* ============ Sample Theme — visual concept ============ */

html[data-theme='sample-theme'] .component { /* ... */ }
```

不要写裸 `.component` 覆盖，也不要在 React 组件中加入人物主题分支。主题之间不共享偶然相同的硬编码颜色；通用改进应修改基础组件，主题特色应留在各自区块。

### 7.1 最低覆盖清单

每个完整人物主题都应逐项评估，而非机械设置所有属性：

- 根节点、选区、焦点环、滚动条、macOS drag strip；
- `.sidebar`、`.sidebar-workspace`、`.session-item` 及选中状态；
- `.btn`、`.btn-primary`、`.btn-icon`、`.select-trigger`、`.select-menu`；
- `.topbar`、`.run-pill`、`.approval-badge`；
- `.conversation`、`.msg-avatar`、双方 `.msg-body`、`.msg-label`；
- `.md` 链接/引用、`.codeblock`、`.thinking`、`.toolcall`；
- `.welcome`、`.empty-workspace`、`.suggestions`；
- `.composer-box`、附件/发送/停止按钮、`.composer-hint`；
- `.telemetry-bar`、`.statusbar`；
- `.right-panel`、`.rp-header`、`.rp-section`、`.patch`；
- `.sett-overlay`、`.sett-sheet`、`.sett-section`、输入框和当前选项；
- `.lightbox`、`.lightbox-img`；
- `.splash`、`.splash-panel`、`.splash-status`、`.splash-footer`。

“完整覆盖”不等于每项都要夸张变化。应从素材提炼形状、材质和氛围，例如纸张、珠宝、泳池反光、综艺标签等，再一致地应用到组件上，同时控制装饰密度。

### 7.2 背景与主体可读性

主区域通常采用主题图叠加方向性渐变：

```css
html[data-theme='sample-theme'] .main {
  background-image:
    linear-gradient(90deg, rgba(250, 250, 250, 0.92) 0%, rgba(250, 250, 250, 0.72) 55%, rgba(250, 250, 250, 0.24) 100%),
    var(--theme-artwork);
  background-position: right center;
  background-size: cover;
  background-repeat: no-repeat;
}
```

渐变方向应根据人物位置调整。消息表面可半透明，但必须有足够背景、边框或阴影保证长文本与代码可读。不要在人物脸部上方叠加主题 quote 或大型装饰字；必要时隐藏 `.app::after`。

### 7.3 Agent 头像回退

带头像主题需要把内部 π 标记隐藏。当前 CSS 使用主题 ID 列表：

```css
html[data-theme='sample-theme'] .msg-avatar-assistant .msg-avatar-pi {
  opacity: 0;
}
```

添加主题时必须更新这一规则，或将其安全重构为基于有无头像的通用状态。不能直接删除 π，因为基础主题仍需要回退头像。

### 7.4 响应式与动效

启动页人物构图在窄窗口不可靠时，使用媒体查询切换到纯色/渐变背景或更安全的定位。主题新增动效必须尊重 `prefers-reduced-motion`，不要让背景持续大幅移动，也不要让 hover 位移造成布局抖动。

## 8. 测试更新

### 8.1 单元测试

更新 `tests/unit/i18n.test.ts`：

1. 主题 ID 数组和测试描述中的数量；
2. 新主题 `hintKey`；
3. `artwork` 和 `avatar` 文件名；
4. `colorScheme`；
5. 有业务意义的 `quote` 或关键属性。

不要只改主题数量而不验证素材，避免设置页看得到主题但 Agent 头像为空。

### 8.2 E2E 测试

更新 `tests/e2e/i18n-theme.spec.ts`：

1. `.sett-theme` 数量；
2. 点击新的中/英文显示名称；
3. `document.documentElement.dataset.theme`；
4. 一个具有辨识度的 CSS 变量，如 `--bg`；
5. 设置页副标题可见；
6. 主题仍写入 `pi-studio-theme`。

主题交互有改动时，还应补充头像灯箱、菜单层级或启动页的针对性测试，而不是只依赖颜色断言。

## 9. 必须执行的验收流程

完成代码后按顺序执行：

```bash
git diff --check
npm run typecheck
npx vitest run
npm run build
```

在环境允许时再运行相关 Electron E2E。E2E 依赖本机路径或图形环境导致失败时，应明确报告原因，不能用单元测试通过代替说明。

还应进行人工视觉检查：

- 设置页缩略图能辨认主题，名称和副标题正确；
- 启动页宽屏/窄屏无黑边，卡片不盖住人物脸部或关键主体；
- 空会话、长对话和有代码/工具调用的会话都可读；
- 用户和 Agent 头像均显示，点击能打开并关闭灯箱；
- 思考强度、模型等下拉菜单不被消息遮挡；
- 输入框只有一个外框，附件、发送和停止按钮状态正常；
- 左右面板、设置、统计和审批弹窗没有遗漏基础主题样式；
- 浅色与深色文本、错误/成功/警告状态均有足够对比度；
- 缩放窗口后不发生水平溢出或主体布局坍塌。

## 10. AI 执行流程

后续 AI 接到“新增主题”任务时，应使用以下流程：

1. 阅读本文，检查工作区未提交改动，保护用户已有修改。
2. 查看原始素材尺寸和实际画面，确认人物位置与可用安全区。
3. 从素材提炼 3–5 个视觉关键词，确定明暗方案、主色、强调色和组件材质。
4. 先制作并查看横向背景和头像；若素材要求不明确，优先保留原图而非重绘人物。
5. 注册 `ThemeId`、完整令牌、目录项和双语文案。
6. 在独立 CSS 区块完成全程序组件级设计，同时遵守布局与交互契约。
7. 更新单元测试与 E2E 断言。
8. 执行静态检查、测试和构建，并在可能时启动应用进行视觉检查。
9. 向用户说明修改文件、素材处理方式、验证结果以及是否已提交/推送。

除非用户明确要求，否则不要自动提交或推送；主题制作完成不等于获得了 Git 发布授权。

## 11. 完成定义（Definition of Done）

只有同时满足以下条件，主题才算完成：

- 能从设置页发现、选择、持久化并正确恢复；
- 背景和头像素材清晰、构图安全且无异常边缘；
- 全部核心界面形成一致而有辨识度的主题语言；
- 对话区、输入区、菜单层级和头像交互没有回归；
- 双语文案、主题目录、单元测试和 E2E 测试同步更新；
- 类型检查、单元测试和正式构建通过；
- 人工视觉检查覆盖启动页、对话页、设置页和至少一个窄窗口场景。

若只是令牌和背景已加入、组件级设计尚未完成，应明确标记为“主题骨架”，不能宣称完整主题已经交付。
