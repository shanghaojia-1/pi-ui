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
9. 主题化文案不得破坏布局。控件标签（如思考强度、审批模式）可能随主题变长，必须能自适应宽度或优雅省略（参考 `Select` 的 `minWidth`/`maxWidth` 模式），不得固定宽度截断或撑破顶栏。

## 3. 代码架构与文件位置

主题系统的主要入口如下：

| 文件 | 职责 |
| --- | --- |
| `src/renderer/src/lib/theme.tsx` | `ThemeId`、设计令牌、主题目录、主背景/右栏竖图/头像注册、CSS 变量注入、`THEME_COPY` 主题专属文案、主题 ID 订阅（`subscribeThemeId`） |
| `src/renderer/src/lib/i18n.tsx` | 基础中英文词典；主题感知的 `t()`（`THEME_COPY` 命中时优先于基础词典） |
| `src/renderer/src/styles.css` | 基础组件样式和各主题的完整组件级覆盖 |
| `src/renderer/src/App.tsx` | 状态栏标准状态映射（`runState` → `app.status.*`），让状态文字走主题文案而非主进程英文 `statusText` |
| `src/renderer/src/assets/` | 原图、处理后的横向主背景、右栏竖图和方形头像 |
| `tests/unit/i18n.test.ts` | 主题目录、翻译、主背景/右栏竖图/头像素材、主题属性和 `THEME_COPY` 文案测试 |
| `tests/e2e/i18n-theme.spec.ts` | 设置页主题数量、切换、CSS 变量、右栏背景/焦点、持久化和人物文案切换测试 |

`THEMES` 是主题元数据的单一事实来源。设置页缩略图、主题切换、启动页标语和 Agent 头像都会从这里读取，不应在组件中另建主题名单。

## 4. 命名规范

新主题先确定一个稳定的 kebab-case 标识，例如 `sample-theme`。相关名称统一如下：

- `ThemeId`：`'sample-theme'`
- 令牌常量：`SAMPLE_THEME`
- 翻译键：`settings.theme.sampleTheme`、`settings.theme.sampleThemeHint`
- CSS 根选择器：`html[data-theme='sample-theme']`
- 素材：`sample-theme-original.png`、`sample-theme-theme.png`、`sample-theme-right-panel.png`、`sample-theme-avatar.png`
- 文案键：直接复用 `i18n.tsx` 的现有 key，不新建 key；主题化文本写在 `THEME_COPY` 里（见第 8 节）

不要用显示名称作为持久化标识，也不要在发布后随意更改 `ThemeId`，因为该值会存入 `localStorage` 的 `pi-studio-theme`。

## 5. 图片素材规范

### 5.1 必备素材

人物主题通常保留四份文件：

- `*-original.*`：用户提供的原始素材，作为可追溯源文件，不在运行时代码中引用；
- `*-theme.png`：应用主背景和启动页使用的横向构图；
- `*-right-panel.png`：右侧活动面板使用的竖向构图，人物主体应放在 `cover` 裁切后仍稳定可见的中央安全区；
- `*-avatar.png`：Agent 消息头像使用的方形裁切。

运行时只导入 `*-theme.png`、`*-right-panel.png` 和 `*-avatar.png`。如果仓库体积成为问题，可在得到用户同意后不提交原图，但不得覆盖唯一原始文件。

### 5.2 背景构图

推荐背景比例为 16:9，基准尺寸为 1792×1024 或 1920×1080。应根据产品布局安排安全区域：

- 人物在右侧时，左侧保留低细节区域供启动卡片和主要文字使用；
- 人物在左侧时反向处理；
- 人脸、手部和关键姿势不能位于常见窗口裁切边缘；
- 用延展画布、渐变、模糊背景或自然环境补全横图，避免简单拉伸人物；
- `cover` 裁切后仍应完整显示人物关键部位，至少检查 16:9、4:3 和约 1000px 宽窗口。

若用户要求保留原图人物，必须使用非生成式处理：裁切、缩放、画布延展、色彩校正、轻度降噪和锐化。不得重绘人物，不得改变身份、脸部、衣着、动作、手势或身体比例。生成式修改只有在用户明确要求且内容允许时才可进行。

处理素材时应保留纵横比，不要放大低分辨率图片到明显失真。避免过度磨皮、过饱和、明显锐化光圈和不可逆地覆盖原图。

### 5.3 右栏竖图构图与裁切

右侧活动面板是独立的窄长展示面，不应直接复用横向主背景。当前布局在 `App.tsx` 中将展开后的右栏固定为 `344px`；应用窗口默认高度为 `920px`，最小高度为 `680px`。竖图推荐使用 `1024×1536` 或同等 `2:3` 比例，并使用 `background-size: cover`。

人物主题的右栏竖图原则上必须包含人物主体，不应只生成调色相近的纯装饰背景，除非用户明确要求无人物。可在用户允许生成式修改时换姿势，但应保留可辨识的身份、主题服装、场景和色彩语言。

构图和焦点必须按实际面板而不是原图观感验收：

- 人脸、躯干和关键姿势应落在竖图中央安全区，左右不要依赖画布边缘；
- 必须同时检查 `344×680`、`344×920` 和 `344×1080` 三种容器；窗口越高，`cover` 对竖图左右的裁切越强；
- 不要因为原图中人物看起来“接近中间”就默认使用 `center center`；应根据裁切后的显示位置设置 `rightPanelArtworkPosition`；
- 当图片渲染宽度大于 `344px` 时，`background-position-x` 的百分比越大，图片整体越向左移；人物显示位置也会向左移；
- 对于高度为 `H`、源图尺寸为 `Wi×Hi` 的常见情况，可用 `s = H / Hi`、`Wr = Wi × s` 估算渲染宽度；人物源图横坐标为 `Xs` 时，为了使其落在面板中心，焦点比例可估算为 `p = (Xs × s - 172) / (Wr - 344)`，最后限制在 `0–1` 并转为百分比；
- 计算只是起点，最终必须在真实右栏中检查人物是否视觉居中，而不是只打开原图查看。

### 5.4 右栏清晰度与内容可读性

主背景要承载长文本，通常需要较强的渐变保护；右栏竖图是更小的主题展示面，图片应比主背景更清晰，不应照搬主背景的遮罩和模糊强度。

- 优先用有足够底色和边框的 `.rp-section`、`.patch` 等卡片保护文字，不要模糊整个 `.right-panel`；
- 右栏主题色渐变应从低不透明度开始，只加到能维持文字层级的程度；浅色主题可从 `0.02–0.12` 试起，深色主题按对比度需求单独调整；
- `backdrop-filter: blur(...)` 会直接模糊卡片背后的人物。`.rp-header`、`.rp-empty` 默认应使用半透明底色而非模糊；确需使用时必须局部化并进行左右清晰度对比；
- 不要在 `.right-panel` 本身上使用 `filter`，否则图片和内部文字、图标都会一起受影响；
- 验收时需并排比较主背景和右栏：右栏人脸与服装细节不应显得更虚，但空状态文字、活动卡片和工具调用仍必须清楚。

### 5.5 头像裁切

头像推荐至少 256×256：

- 以脸部为视觉中心，适当保留发型或具有辨识度的配饰；
- 先从原图直接裁切，再缩放，不从已加渐变的主题横图二次裁切；
- 在 32–34px 的实际显示尺寸下仍应能辨认；
- 通过 `avatarPosition` 微调圆形框中的位置；
- 点击后的灯箱大图不能糊成色块。

### 5.6 素材验收

处理后必须实际打开查看主背景、右栏竖图和头像，不能只相信命令成功。检查：黑边、拼接缝、错误裁切、人物变形、色带、透明通道异常以及文件体积。正式构建还应确认原图没有被意外打入渲染产物。

## 6. 注册主题

### 6.1 导入素材并扩展类型

在 `theme.tsx` 顶部导入运行时素材，并把标识加入 `ThemeId`：

```tsx
import sampleThemeAvatar from '../assets/sample-theme-avatar.png'
import sampleThemeArtwork from '../assets/sample-theme-theme.png'
import sampleThemeRightPanelArtwork from '../assets/sample-theme-right-panel.png'

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
  rightPanelArtwork: sampleThemeRightPanelArtwork,
  rightPanelArtworkPosition: 'center center',
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
- `rightPanelArtwork`：右侧活动面板的独立竖图；无竖图的主题保持默认面板背景；
- `rightPanelArtworkPosition`：竖图在活动面板中的焦点；人物主题应按 5.3 节的实际裁切结果设置，不要无条件固定为 `center center`；
- `avatarPosition`：头像的 `background-position`；
- `quote`：启动页底部主题标语。人物主题还应配套 `THEME_COPY` 专属文案（见第 8 节），让整套产品开口就是这个人。

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

右栏竖图应使用独立变量和焦点，不要复用 `--theme-artwork`：

```css
html[data-theme='sample-theme'] .right-panel {
  background-image:
    linear-gradient(180deg, rgba(250, 250, 250, 0.02), rgba(245, 245, 245, 0.08)),
    var(--theme-right-panel-artwork);
  background-position: center, var(--theme-right-panel-artwork-position);
  background-size: auto, cover;
  background-repeat: no-repeat;
}
```

第一层渐变只用于统一色调和轻微保护，第二层才是竖图。不同背景层的 `background-position` 和 `background-size` 要按逗号顺序一一对应。

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

## 8. 主题专属文案（Persona Copy）

人物主题不仅要换视觉，还要换“口吻”。主题化文案通过 `THEME_COPY` 实现：它是 `theme.tsx` 中以 `ThemeId` 为键、以 i18n key 为子键的 `{ zh, en }` 覆盖表。选中主题命中时优先于基础词典；`system` / `light` / `dark` 不提供专属文案，保持中性基础文本。

### 8.1 机制

- `t()` 每次调用时读取当前主题（`getCurrentThemeId()`），组件无需改动即可拿到人设文案；
- 主题切换通过 `subscribeThemeId()` 通知 `I18nProvider` 重渲染，文案即时生效，无需重启；
- 测试辅助函数 `translate(lang, key, vars?, theme?)` 可指定主题做断言；
- 状态栏：主进程只下发英文 `statusText`，渲染层把标准 `runState`（idle / running / compacting / retrying）映射到 `app.status.*` 键再走 `t()`；后端附加信息（如错误详情）原样透传，不翻译。

### 8.2 覆盖范围

主题化对象是“体验文本”：启动页、欢迎页与建议按钮、空工作区、侧栏（新任务 / 打开目录 / 会话列表 / 删除确认）、顶栏（模型选择 / 思考强度 / 工具审批）、输入框占位符与快捷键提示、斜杠命令描述、状态栏、命令 toast、右侧面板空状态。

以下内容保持基础词典不变：设置表单字段、模型 / 提供商配置、遥测与 token 统计、思考强度选项名、Markdown / 工具调用操作、时间分组、会话统计、aria 标签，以及关闭 / 取消 / 保存等通用操作。俏皮化不得牺牲可用性与可读性。

### 8.3 硬性约束

1. 占位符必须与基础条目完全一致（如 `{n}`、`{path}`、`{cmd}`），漏一个占位符就是运行时 bug；
2. `messages.welcome.desc` / `desc2` 是围绕工作区名拼接的两个片段，中英文都要保证拼起来语法通顺（中：`…在这 <名字> 里…`；英：`…in <name> …`），并保持工作区名前后的空格正确；
3. `messages.suggest.*` 会作为真实 prompt 发送给模型，必须保留可执行的指令语义——只能加语气，不能丢任务；
4. 每个键的中英文都必须与基础文案不同（单元测试强制），避免“看起来改了其实没改”；
5. 控件标签可能变长（如思考强度），布局必须自适应（`Select` 用 `minWidth`/`maxWidth` 模式或省略号），不得固定宽度截断；
6. 双语文案都要写：中英文语气同步人设，不能只优化一种语言。

### 8.4 人设语气

真人主题先调研人物的公开形象（气质、粉丝称呼、代表梗），提炼 3–5 个语气关键词再动笔。仓库内三个主题是可参考的实现：

- 东北雨姐：东北话、老铁文化——“整新活儿”“带派”“唠嗑”；
- 桥本有菜：冷艳撩人、夜色香槟——“新开一夜”“今夜，别急着睡”；
- 三上悠亚：甜妹偶像、撒娇元气——“想要我陪你吗？”“别害羞~”。

语气可以俏皮、有暗示性，但必须保持礼貌边界和功能可理解性；面向真实人物的主题，措辞还应尊重人物本身的公开形象。

## 9. 测试更新

### 9.1 单元测试

更新 `tests/unit/i18n.test.ts`：

1. 主题 ID 数组和测试描述中的数量；
2. 新主题 `hintKey`；
3. `artwork`、`rightPanelArtwork` 和 `avatar` 文件名，以及有特殊裁切需求时的 `rightPanelArtworkPosition`；
4. `colorScheme`；
5. 有业务意义的 `quote` 或关键属性。

不要只改主题数量而不验证素材，避免设置页看得到主题但 Agent 头像为空。

### 9.2 E2E 测试

更新 `tests/e2e/i18n-theme.spec.ts`：

1. `.sett-theme` 数量；
2. 点击新的中/英文显示名称；
3. `document.documentElement.dataset.theme`；
4. 一个具有辨识度的 CSS 变量，如 `--bg`；
5. 人物主题的 `.right-panel` 计算样式已包含对应的 `*-right-panel` 素材；
6. `--theme-right-panel-artwork-position` 与主题目录一致；若主题明确要求右栏保持清晰，还应断言 `.rp-header` 等关键区域没有意外的 `backdrop-filter`；
7. 设置页副标题可见；
8. 主题仍写入 `pi-studio-theme`。

主题交互有改动时，还应补充头像灯箱、菜单层级或启动页的针对性测试，而不是只依赖颜色断言。

提供 `THEME_COPY` 的主题还须验证：

1. 每个人物主题的文案键集合一致（用同一份键清单，防止漏写某个入口）；
2. 每个键中英文均与基础文案不同，且占位符完整保留；
3. `welcome.desc` / `desc2` 拼接后语法通顺（单元测试可拼出完整句子断言）；
4. E2E 断言切换人物主题后侧栏 / 欢迎页文案立即变化（如按钮从“新任务”变为“整新活儿”），切回 `system` 后恢复基础文案。

## 10. 必须执行的验收流程

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
- 右栏在 `344×680`、`344×920` 和 `344×1080` 三种尺寸下都没有将人脸或关键姿势裁出，人物不贴左/右边缘；
- 右栏的空状态和有活动卡片状态都已检查，图片比主背景清晰且文字仍可读；
- 浅色与深色文本、错误/成功/警告状态均有足够对比度；
- 缩放窗口后不发生水平溢出或主体布局坍塌；
- 主题文案：中英文切换正确、切主题即时刷新、控件标签无截断、占位符完整；
- 人物主题抽查 5 个以上界面入口，口吻与人物设定一致，且未污染技术性文本。

## 11. AI 执行流程

后续 AI 接到“新增主题”任务时，应使用以下流程：

1. 阅读本文，检查工作区未提交改动，保护用户已有修改。
2. 查看原始素材尺寸和实际画面，确认人物位置与可用安全区。
3. 从素材提炼 3–5 个视觉关键词，确定明暗方案、主色、强调色和组件材质。
4. 先制作并查看横向背景、右栏竖图和头像；右栏必须按 `344px` 实际宽度试裁切。若素材要求不明确，优先保留原图而非重绘人物。
5. 注册 `ThemeId`、完整令牌、目录项和双语文案。
6. 人物主题：先调研人物公开形象、提炼语气关键词，再编写 `THEME_COPY` 专属文案（见第 8 节）。
7. 在独立 CSS 区块完成全程序组件级设计，同时遵守布局与交互契约。
8. 更新单元测试与 E2E 断言，含文案键覆盖、占位符和切换生效验证。
9. 执行静态检查、测试和构建，并在可能时启动应用进行视觉检查。
10. 向用户说明修改文件、素材处理方式、验证结果以及是否已提交/推送。

除非用户明确要求，否则不要自动提交或推送；主题制作完成不等于获得了 Git 发布授权。

## 12. 完成定义（Definition of Done）

只有同时满足以下条件，主题才算完成：

- 能从设置页发现、选择、持久化并正确恢复；
- 主背景、右栏竖图和头像素材清晰、构图安全且无异常边缘；
- 全部核心界面形成一致而有辨识度的主题语言；
- 对话区、输入区、菜单层级和头像交互没有回归；
- 人物主题的体验文本全部人设化（`THEME_COPY`），技术性文本保持中性；
- 主题文案中英文成对、占位符完整、切换即时生效且控件无截断；
- 双语文案、主题目录、单元测试和 E2E 测试同步更新；
- 类型检查、单元测试和正式构建通过；
- 人工视觉检查覆盖启动页、对话页、设置页、右栏空/非空状态和至少一个窄窗口场景。

若只是令牌和背景已加入、组件级设计尚未完成，应明确标记为“主题骨架”，不能宣称完整主题已经交付。
