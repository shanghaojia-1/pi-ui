import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import dongbeiYujieAvatar from '../assets/dongbei-yujie-avatar.png'
import dongbeiYujieArtwork from '../assets/dongbei-yujie-theme.png'
import hashimotoYunaAvatar from '../assets/hashimoto-yuna-avatar.png'
import hashimotoYunaArtwork from '../assets/hashimoto-yuna-theme-v2.png'
import mikamiYuaAvatar from '../assets/mikami-yua-avatar.png'
import mikamiYuaArtwork from '../assets/mikami-yua-theme.png'

export type ThemeId = 'system' | 'light' | 'dark' | 'dongbei-yujie' | 'hashimoto-yuna' | 'mikami-yua'

type ThemeVariable =
  | '--bg'
  | '--bg-panel'
  | '--bg-elevated'
  | '--bg-subtle'
  | '--bg-hover'
  | '--bg-active'
  | '--border'
  | '--border-strong'
  | '--text'
  | '--text-2'
  | '--text-3'
  | '--text-3-strong'
  | '--accent'
  | '--accent-strong'
  | '--accent-soft'
  | '--green'
  | '--green-soft'
  | '--red'
  | '--red-soft'
  | '--amber'
  | '--amber-soft'
  | '--blue'
  | '--blue-soft'

type ThemeVariables = Readonly<Record<ThemeVariable, string>>

export interface ThemeDefinition {
  readonly id: ThemeId
  readonly labelKey: string
  readonly hintKey?: string
  readonly swatch: string
  readonly colorScheme: 'light' | 'dark'
  readonly variables: ThemeVariables
  readonly artwork?: string
  readonly artworkPosition?: string
  readonly artworkOpacity?: number
  readonly avatar?: string
  readonly avatarPosition?: string
  readonly quote?: string
}

const LIGHT: ThemeVariables = {
  '--bg': '#f6f4f1',
  '--bg-panel': '#fbfaf8',
  '--bg-elevated': '#ffffff',
  '--bg-subtle': '#efede8',
  '--bg-hover': '#e9e6df',
  '--bg-active': '#e3dfd6',
  '--border': '#e3e0d8',
  '--border-strong': '#cec9bf',
  '--text': '#2c2a26',
  '--text-2': '#6d695f',
  '--text-3': '#a19b8f',
  '--text-3-strong': '#8a857a',
  '--accent': '#bf5b2c',
  '--accent-strong': '#a64a20',
  '--accent-soft': '#f6e7dd',
  '--green': '#4d7c4f',
  '--green-soft': '#e7f0e4',
  '--red': '#b6452f',
  '--red-soft': '#f6e3de',
  '--amber': '#a67c1b',
  '--amber-soft': '#f5ecd7',
  '--blue': '#386fa0',
  '--blue-soft': '#e3edf5',
}

const DARK: ThemeVariables = {
  '--bg': '#1d1c1a',
  '--bg-panel': '#21201e',
  '--bg-elevated': '#262522',
  '--bg-subtle': '#2a2925',
  '--bg-hover': '#31302c',
  '--bg-active': '#383631',
  '--border': '#33312d',
  '--border-strong': '#45423c',
  '--text': '#e8e5df',
  '--text-2': '#a7a297',
  '--text-3': '#6f6a61',
  '--text-3-strong': '#8b857a',
  '--accent': '#d97b4a',
  '--accent-strong': '#e89a6e',
  '--accent-soft': '#3d2a20',
  '--green': '#82b184',
  '--green-soft': '#222f1f',
  '--red': '#e0806a',
  '--red-soft': '#3a2420',
  '--amber': '#d3a64f',
  '--amber-soft': '#332b19',
  '--blue': '#7fa8cc',
  '--blue-soft': '#1f2b36',
}

const DONG_BEI_YUJIE: ThemeVariables = {
  '--bg': '#fff0f5',
  '--bg-panel': '#fff8fb',
  '--bg-elevated': '#ffffff',
  '--bg-subtle': '#ffe3ee',
  '--bg-hover': '#ffd6e5',
  '--bg-active': '#ffc5da',
  '--border': '#f3bfd2',
  '--border-strong': '#e898b5',
  '--text': '#54283b',
  '--text-2': '#8b5268',
  '--text-3': '#b9899b',
  '--text-3-strong': '#a36b82',
  '--accent': '#e65387',
  '--accent-strong': '#c83268',
  '--accent-soft': '#ffe0ec',
  '--green': '#5b906c',
  '--green-soft': '#e3f2e7',
  '--red': '#c94a5b',
  '--red-soft': '#ffe1e5',
  '--amber': '#b98728',
  '--amber-soft': '#fff0cf',
  '--blue': '#4d7ea6',
  '--blue-soft': '#e2f0fa',
}

const HASHIMOTO_YUNA: ThemeVariables = {
  '--bg': '#120e11',
  '--bg-panel': '#191317',
  '--bg-elevated': '#251c21',
  '--bg-subtle': '#302229',
  '--bg-hover': '#3c2a32',
  '--bg-active': '#493039',
  '--border': '#3e2d34',
  '--border-strong': '#654750',
  '--text': '#f4eee9',
  '--text-2': '#c9b9ae',
  '--text-3': '#8f7c76',
  '--text-3-strong': '#ad9790',
  '--accent': '#d5aa7e',
  '--accent-strong': '#f0c99e',
  '--accent-soft': '#3c2a24',
  '--green': '#7eae8c',
  '--green-soft': '#1d3025',
  '--red': '#e07882',
  '--red-soft': '#3b2028',
  '--amber': '#d5aa7e',
  '--amber-soft': '#362a20',
  '--blue': '#8da9c4',
  '--blue-soft': '#202b36',
}

const MIKAMI_YUA: ThemeVariables = {
  '--bg': '#eaf8ff',
  '--bg-panel': '#f7fcff',
  '--bg-elevated': '#ffffff',
  '--bg-subtle': '#dff3ff',
  '--bg-hover': '#ccecff',
  '--bg-active': '#b9e3fa',
  '--border': '#b9ddec',
  '--border-strong': '#82bdd7',
  '--text': '#17384c',
  '--text-2': '#4f7185',
  '--text-3': '#86a5b6',
  '--text-3-strong': '#6e91a4',
  '--accent': '#0b94d8',
  '--accent-strong': '#0876af',
  '--accent-soft': '#d5f1ff',
  '--green': '#399b82',
  '--green-soft': '#dcf4ed',
  '--red': '#db6874',
  '--red-soft': '#ffe5e8',
  '--amber': '#b8842d',
  '--amber-soft': '#fff1d7',
  '--blue': '#168dcc',
  '--blue-soft': '#d9f1fd',
}

/**
 * Theme-flavored UI copy. Keys are i18n keys; when the selected theme defines
 * an entry here it wins over the base dictionary. Only the persona themes
 * (dongbei-yujie / hashimoto-yuna / mikami-yua) carry flavor text; system,
 * light and dark keep the neutral base copy.
 *
 * Placeholders ({n}, {path}, {cmd}…) must match the base entry exactly.
 */
export type ThemeCopyEntry = Readonly<{ zh: string; en: string }>

export const THEME_COPY: Readonly<Partial<Record<ThemeId, Readonly<Record<string, ThemeCopyEntry>>>>> = {
  'dongbei-yujie': {
    // splash
    'app.splash.title': { zh: '老铁，开整了！', en: 'Old iron, let\'s get to it!' },
    'app.splash.subtitle': { zh: '工作区这就给你收拾得板板正正', en: 'Getting your workspace shipshape' },
    'app.splash.connecting': { zh: '正给你安排呢…', en: 'Setting things up…' },
    // banners & empty workspace
    'app.banner.recoverable': { zh: '没事儿，发条新消息接着整', en: 'No worries — send a new message and keep going' },
    'app.noModels.title': { zh: '模型咋还没影儿呢？', en: 'Where\'d all the models go?' },
    'app.noModels.detail': { zh: '瞅瞅模型 API 配置和登录状态，再重新打开工作区。', en: 'Check the model API config and sign-in, then reopen the workspace.' },
    'app.emptyWorkspace.title': { zh: '把项目文件夹整进来', en: 'Bring in a project folder' },
    'app.emptyWorkspace.desc': { zh: '选好目录咱就开整：新任务、会话管理，让 Pi 在真代码上可劲儿造。', en: 'Pick a folder and we\'re off: new tasks, sessions, and Pi going hard on real code.' },
    'app.emptyWorkspace.open': { zh: '挑个目录', en: 'Pick a folder' },
    // statusbar
    'app.status.ready': { zh: '整好了，带派！', en: 'All set — solid!' },
    'app.status.working': { zh: 'Pi 正搁那儿嘎嘎干活呢…', en: 'Pi is hustling away…' },
    'app.status.compacting': { zh: '正归拢上下文呢…', en: 'Tidying up the context…' },
    'app.status.retrying': { zh: '没接上，麻溜再试…', en: 'Dropped the call — retrying…' },
    'app.status.queue': { zh: '后边排着 {n} 个', en: 'In line +{n}' },
    // command toasts
    'app.command.compacting': { zh: '正归拢上下文…', en: 'Tidying the context…' },
    'app.command.copied': { zh: '最后一句给你收好了', en: 'Last reply saved' },
    'app.command.nothingToCopy': { zh: '没啥可复制的', en: 'Nothing to grab' },
    'app.command.exported': { zh: '导出完了：{path}', en: 'Done — saved to {path}' },
    'app.command.exportCancelled': { zh: '不导了，听你的', en: 'Skipped the export' },
    'app.command.reloading': { zh: '正重新加载扩展 / 技能 / 模板…', en: 'Freshening extensions / skills / templates…' },
    'app.command.nameHint': { zh: '给会话起个名，如 /name 重构计划', en: 'Give the session a name, e.g. /name refactor-plan' },
    'app.command.unknown': { zh: '这命令我没见过 /{cmd}', en: 'Never heard of /{cmd}' },
    // sidebar
    'sidebar.newTask': { zh: '整新活儿', en: 'Fresh task' },
    'sidebar.openDir': { zh: '挑个目录', en: 'Pick a folder' },
    'sidebar.sessionsLabel': { zh: '唠过的嗑', en: 'Chats' },
    'sidebar.noSessions': { zh: '还没唠过呢', en: 'No chats yet' },
    'sidebar.openDirHint': { zh: '挑个目录就能唠', en: 'Pick a folder to chat' },
    'sidebar.workspaceNotOpen': { zh: '还没挑目录', en: 'No folder yet' },
    'sidebar.noMessages': { zh: '还没开嗓', en: 'Nothing said' },
    'sidebar.deleteSession': { zh: '删了这唠', en: 'Delete chat' },
    'sidebar.confirmDelete': { zh: '真删啊？', en: 'Really delete?' },
    'sidebar.confirmDeleteHint': { zh: '再点一下，说删就删', en: 'Click again to make it so' },
    // topbar
    'topbar.noModel': { zh: '没瞅着模型', en: 'No model found' },
    'topbar.selectModel': { zh: '挑个模型', en: 'Pick a model' },
    'topbar.thinkingLabel': { zh: '用多大劲儿想', en: 'Thinking effort' },
    'topbar.approval': { zh: '工具放行', en: 'Tool sign-off' },
    'topbar.approval.ask': { zh: '每回都问一声', en: 'Ask me every time' },
    'topbar.approval.managed': { zh: '全托管 · 可劲造', en: 'Managed · full send' },
    // composer
    'composer.placeholder.workspace': { zh: '先把目录整进来', en: 'Drag a folder in first' },
    'composer.placeholder.noModels': { zh: '没模型，瞅瞅 API 鉴权', en: 'No models — check your API auth' },
    'composer.placeholder.followUp': { zh: '接着唠，发出去就排队跟上…', en: 'Keep typing — it will queue right behind…' },
    'composer.placeholder.idle': { zh: '跟老铁唠唠，想整点啥活儿？', en: 'Tell me, old iron — what are we building?' },
    'composer.hint.running': { zh: '整着呢 — 接着输入，发出去就排队跟上', en: 'Working — keep typing and send to queue a follow-up' },
    'composer.hint.idle': { zh: 'Enter 开整 · Shift+Enter 换行 · {kbd} 聚焦输入 · 可拖入/粘贴图片', en: 'Enter go · Shift+Enter newline · {kbd} focus · drag/paste images' },
    // slash commands
    'composer.slash.new': { zh: '整新活儿（开个新会话）', en: 'Kick off a fresh task (new session)' },
    'composer.slash.resume': { zh: '翻翻唠过的嗑', en: 'Browse past chats' },
    'composer.slash.name': { zh: '给这唠换个名', en: 'Rename this chat' },
    'composer.slash.compact': { zh: '手动归拢上下文', en: 'Manually tidy the context' },
    'composer.slash.copy': { zh: '收走最后一句', en: 'Grab the last reply' },
    'composer.slash.export': { zh: '把这唠导出成 JSONL', en: 'Export this chat as JSONL' },
    'composer.slash.session': { zh: '瞅瞅这唠的账本', en: 'Check this chat\'s stats' },
    'composer.slash.model': { zh: '换个模型', en: 'Swap the model' },
    'composer.slash.settings': { zh: '去设置里捯饬捯饬', en: 'Tweak the settings' },
    'composer.slash.login': { zh: '配 API Key / 登录', en: 'Set up API key / sign in' },
    'composer.slash.reload': { zh: '换新扩展 / 技能 / 模板', en: 'Refresh extensions / skills / templates' },
    'composer.slash.quit': { zh: '撤了', en: 'Call it a day' },
    // welcome & suggestions
    'messages.welcome.title': { zh: '开整新活儿！', en: 'Let\'s start a fresh task!' },
    'messages.welcome.desc': { zh: '跟老铁唠唠，想在这', en: 'Tell me, old iron — what do you want Pi to do in' },
    'messages.welcome.desc2': { zh: '里整点啥活儿？', en: ' today?' },
    'messages.welcome.shortcuts': { zh: '{kbdN} 整新活儿 · {kbdK} 聚焦输入 · {kbdO} 挑目录 · Enter 开整 · Esc 停手', en: '{kbdN} fresh task · {kbdK} focus input · {kbdO} open folder · Enter go · Esc stop' },
    'messages.suggest.explore': { zh: '把项目扒个底朝天：总结结构、主要模块', en: 'Dig through this project: structure and key modules' },
    'messages.suggest.test': { zh: '跑一遍测试，把挂了的修好', en: 'Run the tests and fix the failures' },
    'messages.suggest.review': { zh: '翻翻最近的改动，瞅瞅有啥毛病', en: 'Review recent changes and flag issues' },
    'messages.thinkingIdle': { zh: '搁那儿琢磨呢…', en: 'Mulling it over…' },
    // right panel
    'rightPanel.noActivity': { zh: '还没动静', en: 'No action yet' },
    'rightPanel.noActivitySub': { zh: '一唠起来，文件变更、工具运行和用量就都搁这儿了', en: 'File changes, tool runs and usage show up here once you chat' },
    'settings.noModelsHint': { zh: '没模型可用，先配 API Key 或跑 pi /login', en: 'No models around — add an API key or run pi /login' },
  },

  'hashimoto-yuna': {
    // splash
    'app.splash.title': { zh: '夜色正浓，想来点刺激的吗？', en: 'The night is hot — feeling adventurous?' },
    'app.splash.subtitle': { zh: '正在为你准备今晚的惊喜', en: 'Preparing tonight\'s surprise for you' },
    'app.splash.connecting': { zh: '正在调暗灯光…', en: 'Dimming the lights…' },
    // banners & empty workspace
    'app.banner.recoverable': { zh: '别急，慢慢来，发条新消息我们继续', en: 'Take it slow — send a new message and we continue' },
    'app.noModels.title': { zh: '今晚没约到模型', en: 'No models got the invite tonight' },
    'app.noModels.detail': { zh: '检查模型 API 配置与登录状态，然后重新打开工作区。', en: 'Check the model API config and sign-in, then reopen the workspace.' },
    'app.emptyWorkspace.title': { zh: '挑个文件夹，找个私密的地方', en: 'Pick a folder — somewhere private' },
    'app.emptyWorkspace.desc': { zh: '选好目录，让 Pi 在真实代码里好好服侍你。', en: 'Choose a folder and let Pi serve you deep in your code.' },
    'app.emptyWorkspace.open': { zh: '挑个地方', en: 'Pick a place' },
    // statusbar
    'app.status.ready': { zh: '一切都准备好了，等你来', en: 'All set — waiting for you' },
    'app.status.working': { zh: 'Pi 正在为你卖力…', en: 'Pi is working hard for you…' },
    'app.status.compacting': { zh: '正在清理现场…', en: 'Cleaning up the scene…' },
    'app.status.retrying': { zh: '刚才不够尽兴，再来一次…', en: 'That wasn\'t enough — one more round…' },
    'app.status.queue': { zh: '后面还排着 {n} 个等你的', en: 'Waiting +{n}' },
    // command toasts
    'app.command.compacting': { zh: '正在清理现场…', en: 'Cleaning up the scene…' },
    'app.command.copied': { zh: '最后一句已为你存好，随时回味', en: 'Last reply saved — ready for a replay' },
    'app.command.nothingToCopy': { zh: '还没有值得回味的内容', en: 'Nothing worth replaying yet' },
    'app.command.exported': { zh: '存档完成：{path}', en: 'Saved: {path}' },
    'app.command.exportCancelled': { zh: '今晚先不留存档了', en: 'No keepsake tonight' },
    'app.command.reloading': { zh: '正在重新准备扩展 / 技能 / 模板…', en: 'Refreshing extensions / skills / templates…' },
    'app.command.nameHint': { zh: '给这一夜起个名，如 /name 重构计划', en: 'Name this night, e.g. /name refactor-plan' },
    'app.command.unknown': { zh: '这支舞曲我不会 /{cmd}', en: 'Never heard of /{cmd}' },
    // sidebar
    'sidebar.newTask': { zh: '新开一夜', en: 'New night' },
    'sidebar.openDir': { zh: '挑个地方', en: 'Pick a place' },
    'sidebar.sessionsLabel': { zh: '春宵记录', en: 'Rendezvous' },
    'sidebar.noSessions': { zh: '今晚还没人来', en: 'No one came by tonight' },
    'sidebar.openDirHint': { zh: '挑个地方，我们就能开始', en: 'Pick a place and we can begin' },
    'sidebar.workspaceNotOpen': { zh: '还没挑地方', en: 'No place yet' },
    'sidebar.noMessages': { zh: '还没发出一点声音', en: 'Not a sound yet' },
    'sidebar.deleteSession': { zh: '结束这一夜', en: 'End this night' },
    'sidebar.confirmDelete': { zh: '确定要结束吗？', en: 'Ready to call it a night?' },
    'sidebar.confirmDeleteHint': { zh: '再点一下，这一夜就没了', en: 'Click again — this night will be gone' },
    // topbar
    'topbar.noModel': { zh: '今晚没人陪你', en: 'No one to keep you company tonight' },
    'topbar.selectModel': { zh: '挑个伴儿', en: 'Pick a partner' },
    'topbar.thinkingLabel': { zh: '要多深', en: 'How deep' },
    'topbar.approval': { zh: '放行一切', en: 'Full access' },
    'topbar.approval.ask': { zh: '每一下都先问你', en: 'Ask before every move' },
    'topbar.approval.managed': { zh: '全托管 · 任你摆布', en: 'Managed · at your mercy' },
    // composer
    'composer.placeholder.workspace': { zh: '先找个地方，我们才能开始', en: 'Find a place first, then we begin' },
    'composer.placeholder.noModels': { zh: '没人可用，看看 API 鉴权', en: 'No models — check your API auth' },
    'composer.placeholder.followUp': { zh: '还没尽兴？继续写，马上轮到你…', en: 'Want more? Keep typing — you\'re next…' },
    'composer.placeholder.idle': { zh: '想要我做什么？大胆说出来…', en: 'What do you want me to do? Don\'t be shy…' },
    'composer.hint.running': { zh: '进行中 — 别停，继续输入排队跟上', en: 'In action — keep typing to queue up next' },
    'composer.hint.idle': { zh: 'Enter 开始 · Shift+Enter 换行 · {kbd} 聚焦输入 · 可拖入/粘贴图片', en: 'Enter go · Shift+Enter newline · {kbd} focus · drag/paste images' },
    // slash commands
    'composer.slash.new': { zh: '新开一夜（新会话）', en: 'Start a new night (session)' },
    'composer.slash.resume': { zh: '翻翻春宵记录', en: 'Browse past rendezvous' },
    'composer.slash.name': { zh: '给这一夜起个名', en: 'Name this night' },
    'composer.slash.compact': { zh: '整理一下上下文', en: 'Tidy the context' },
    'composer.slash.copy': { zh: '收藏最后一句', en: 'Keep the last line' },
    'composer.slash.export': { zh: '把这夜存进档案', en: 'Archive this night as JSONL' },
    'composer.slash.session': { zh: '看看这一夜的战果', en: 'Check tonight\'s stats' },
    'composer.slash.model': { zh: '换位主角', en: 'Switch the star' },
    'composer.slash.settings': { zh: '去后台（设置）', en: 'Head backstage (settings)' },
    'composer.slash.login': { zh: '补上 API Key / 登录', en: 'Add your API key / sign in' },
    'composer.slash.reload': { zh: '重新准备扩展 / 技能 / 模板', en: 'Refresh extensions / skills / templates' },
    'composer.slash.quit': { zh: '说晚安', en: 'Say goodnight' },
    // welcome & suggestions
    'messages.welcome.title': { zh: '今夜，别急着睡', en: 'Tonight, don\'t rush to bed' },
    'messages.welcome.desc': { zh: '告诉我，想让我在这', en: 'Tell me what you want me to do in' },
    'messages.welcome.desc2': { zh: '里陪你做点什么？', en: ' tonight — I\'ll handle the rest' },
    'messages.welcome.shortcuts': { zh: '{kbdN} 新开一夜 · {kbdK} 聚焦 · {kbdO} 挑地方 · Enter 开始 · Esc 停下', en: '{kbdN} new night · {kbdK} focus · {kbdO} pick a place · Enter go · Esc stop' },
    'messages.suggest.explore': { zh: '把这个项目摸个透：结构、主要模块', en: 'Get to know this project inside out: structure and key modules' },
    'messages.suggest.test': { zh: '跑一遍测试，把不行的地方都修好', en: 'Run the tests and fix what\'s off' },
    'messages.suggest.review': { zh: '翻翻最近的改动，指出有问题的', en: 'Review recent changes and point out what\'s wrong' },
    'messages.thinkingIdle': { zh: '正在进入状态…', en: 'Getting in the mood…' },
    // right panel
    'rightPanel.noActivity': { zh: '还没有任何动静', en: 'Not a single move yet' },
    'rightPanel.noActivitySub': { zh: '开始之后，文件变更、工具运行和用量都会在这里留下痕迹', en: 'Once we start, file changes, tool runs and usage leave their marks here' },
    'settings.noModelsHint': { zh: '暂无可用模型，先配 API Key 或运行 pi /login', en: 'No models — add an API key or run pi /login' },
  },

  'mikami-yua': {
    // splash
    'app.splash.title': { zh: '海风正好，想要一场刺激的冒险吗？', en: 'Fair winds — feeling adventurous?' },
    'app.splash.subtitle': { zh: '正在把工作区收拾得又香又软哦', en: 'Making your workspace soft and ready for you' },
    'app.splash.connecting': { zh: '正在准备好自己，马上就好~', en: 'Getting ready for you…' },
    // banners & empty workspace
    'app.banner.recoverable': { zh: '没关系的，再发一条，我们继续哦~', en: 'No worries — send a new message and we keep going~' },
    'app.noModels.title': { zh: '今晚的搭档还没到哦', en: 'Your partner hasn\'t arrived yet' },
    'app.noModels.detail': { zh: '检查模型 API 配置与登录状态，然后重新打开工作区。', en: 'Check the model API config and sign-in, then reopen the workspace.' },
    'app.emptyWorkspace.title': { zh: '挑一个文件夹，我们单独待会儿', en: 'Pick a folder — just the two of us' },
    'app.emptyWorkspace.desc': { zh: '选好目录，我就能在代码里好好陪你啦', en: 'Choose a folder and I\'ll take care of everything in your code' },
    'app.emptyWorkspace.open': { zh: '挑个地方', en: 'Pick a place' },
    // statusbar
    'app.status.ready': { zh: '我准备好了，随时可以开始哦', en: 'I\'m all yours — ready when you are' },
    'app.status.working': { zh: 'Pi 正为你卖力着呢…', en: 'Pi is working hard for you…' },
    'app.status.compacting': { zh: '正在收拾房间…', en: 'Tidying up the room…' },
    'app.status.retrying': { zh: '刚才没发挥好，再来一次嘛…', en: 'That round didn\'t count — one more try?' },
    'app.status.queue': { zh: '后面还有 {n} 个人等你哦', en: 'Waiting +{n}' },
    // command toasts
    'app.command.compacting': { zh: '正在收拾房间…', en: 'Tidying up the room…' },
    'app.command.copied': { zh: '最后一句已收进我的小口袋啦', en: 'Last reply tucked into my little pocket' },
    'app.command.nothingToCopy': { zh: '口袋里还空空的哦', en: 'My pocket is still empty~' },
    'app.command.exported': { zh: '已藏好：{path}', en: 'Hidden away: {path}' },
    'app.command.exportCancelled': { zh: '这次先不留啦', en: 'Nothing to keep tonight' },
    'app.command.reloading': { zh: '正在刷新扩展 / 技能 / 模板…', en: 'Refreshing extensions / skills / templates…' },
    'app.command.nameHint': { zh: '给这一夜起个名，如 /name 重构计划', en: 'Name this night, e.g. /name refactor-plan' },
    'app.command.unknown': { zh: '这首歌我不会唱 /{cmd}', en: 'Never heard of /{cmd}' },
    // sidebar
    'sidebar.newTask': { zh: '一起扬帆吧', en: 'Set sail together' },
    'sidebar.openDir': { zh: '挑个地方', en: 'Pick a place' },
    'sidebar.sessionsLabel': { zh: '我们的回忆', en: 'Our memories' },
    'sidebar.noSessions': { zh: '还没有我们的回忆哦', en: 'No memories yet~' },
    'sidebar.openDirHint': { zh: '挑个地方，我们就能开始', en: 'Pick a place and we can begin' },
    'sidebar.workspaceNotOpen': { zh: '还没挑地方', en: 'No place yet' },
    'sidebar.noMessages': { zh: '还没说过话呢', en: 'We haven\'t even talked yet' },
    'sidebar.deleteSession': { zh: '忘掉这一夜', en: 'Forget this night' },
    'sidebar.confirmDelete': { zh: '确定要忘记吗？', en: 'Really want to forget?' },
    'sidebar.confirmDeleteHint': { zh: '再点一下，回忆就没了哦', en: 'Click again and it\'s gone forever' },
    // topbar
    'topbar.noModel': { zh: '没人陪你哦', en: 'No one to play with' },
    'topbar.selectModel': { zh: '挑一个陪你的人', en: 'Pick someone to play with' },
    'topbar.thinkingLabel': { zh: '想要多深呢', en: 'How deep, baby?' },
    'topbar.approval': { zh: '都交给我吧', en: 'Leave it all to me' },
    'topbar.approval.ask': { zh: '每一下都会先问你哦', en: 'I\'ll ask before every move' },
    'topbar.approval.managed': { zh: '全托管 · 任你掌控', en: 'Managed · all yours' },
    // composer
    'composer.placeholder.workspace': { zh: '先挑个地方，我们才能开始哦', en: 'Pick a place first, then we start' },
    'composer.placeholder.noModels': { zh: '没人可用，看看 API 鉴权', en: 'No models — check your API auth' },
    'composer.placeholder.followUp': { zh: '还没够吗？继续写，马上就轮到你哦', en: 'Want more? Keep typing — you\'re next~' },
    'composer.placeholder.idle': { zh: '想要我做什么？说嘛，别害羞~', en: 'What do you want me to do? Don\'t be shy~' },
    'composer.hint.running': { zh: '进行中 — 别停，继续输入就轮到你了哦', en: 'In action — keep typing to queue up next~' },
    'composer.hint.idle': { zh: 'Enter 开始 · Shift+Enter 换行 · {kbd} 聚焦输入 · 可拖入/粘贴图片', en: 'Enter go · Shift+Enter newline · {kbd} focus · drag/paste images' },
    // slash commands
    'composer.slash.new': { zh: '开启新的一夜（新会话）', en: 'Start a new night (session)' },
    'composer.slash.resume': { zh: '翻翻我们的回忆', en: 'Browse our memories' },
    'composer.slash.name': { zh: '给这一夜起个名字', en: 'Name this night' },
    'composer.slash.compact': { zh: '整理船舱（压缩上下文）', en: 'Tidy the cabin (compact context)' },
    'composer.slash.copy': { zh: '收藏好最后一句', en: 'Keep the last line safe' },
    'composer.slash.export': { zh: '把这一夜存进档案', en: 'Archive this night as JSONL' },
    'composer.slash.session': { zh: '看看这一夜的成果', en: 'Check tonight\'s results' },
    'composer.slash.model': { zh: '换一位水手', en: 'Swap the crew' },
    'composer.slash.settings': { zh: '去船长室（设置）', en: 'Visit the captain\'s quarters (settings)' },
    'composer.slash.login': { zh: '补给 API Key / 登录', en: 'Stock up on API key / sign in' },
    'composer.slash.reload': { zh: '刷新扩展 / 技能 / 模板', en: 'Refresh extensions / skills / templates' },
    'composer.slash.quit': { zh: '晚安，亲爱的', en: 'Goodnight, darling' },
    // welcome & suggestions
    'messages.welcome.title': { zh: '想要我陪你开始新任务吗？', en: 'Want me to start a new task with you?' },
    'messages.welcome.desc': { zh: '想让我在这', en: 'Tell me what you want Pi to do in' },
    'messages.welcome.desc2': { zh: '里好好陪你吗？', en: ' — I\'ll do it all for you' },
    'messages.welcome.shortcuts': { zh: '{kbdN} 开启新夜 · {kbdK} 聚焦 · {kbdO} 挑地方 · Enter 开始 · Esc 停下', en: '{kbdN} new night · {kbdK} focus · {kbdO} pick a place · Enter go · Esc stop' },
    'messages.suggest.explore': { zh: '把这个项目摸透：结构、主要模块', en: 'Get to know this project inside and out' },
    'messages.suggest.test': { zh: '跑一遍测试，把不过的修好', en: 'Run the tests and fix the failures' },
    'messages.suggest.review': { zh: '翻翻最近的改动，告诉我在哪需要注意', en: 'Review recent changes and tell me what to watch' },
    'messages.thinkingIdle': { zh: '正在调整状态等你呢…', en: 'Getting ready for you…' },
    // right panel
    'rightPanel.noActivity': { zh: '还没有任何动静呢', en: 'Not a single move yet' },
    'rightPanel.noActivitySub': { zh: '开始后，文件变更、工具运行和用量都会在这里留下痕迹哦', en: 'Once we start, everything leaves a trace here~' },
    'settings.noModelsHint': { zh: '暂无可用模型，先配 API Key 或运行 pi /login', en: 'No models — add an API key or run pi /login' },
  },
}

/**
 * The theme catalog is the single source of truth for labels, swatches,
 * tokens, and optional artwork. New themes must also provide translations,
 * scoped component styling, assets, and tests. Follow
 * docs/THEME_DEVELOPMENT.md for the complete implementation contract.
 */
export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'system',
    labelKey: 'settings.theme.system',
    swatch: 'linear-gradient(135deg, #f6f4f1 50%, #1d1c1a 50%)',
    colorScheme: 'light',
    variables: LIGHT,
  },
  { id: 'light', labelKey: 'settings.theme.light', swatch: '#f6f4f1', colorScheme: 'light', variables: LIGHT },
  { id: 'dark', labelKey: 'settings.theme.dark', swatch: '#1d1c1a', colorScheme: 'dark', variables: DARK },
  {
    id: 'dongbei-yujie',
    labelKey: 'settings.theme.dongbeiYujie',
    hintKey: 'settings.theme.dongbeiYujieHint',
    swatch: 'linear-gradient(135deg, #ffb5cf 0%, #e65387 52%, #ffd8e7 52%, #fff0f5 100%)',
    colorScheme: 'light',
    variables: DONG_BEI_YUJIE,
    artwork: dongbeiYujieArtwork,
    artworkPosition: 'center center',
    artworkOpacity: 0.92,
    avatar: dongbeiYujieAvatar,
    avatarPosition: 'center 34%',
    quote: '带派不老铁 · Pi Agent',
  },
  {
    id: 'hashimoto-yuna',
    labelKey: 'settings.theme.hashimotoYuna',
    hintKey: 'settings.theme.hashimotoYunaHint',
    swatch: 'linear-gradient(135deg, #120e11 0%, #4a1728 58%, #d5aa7e 58%, #f0c99e 100%)',
    colorScheme: 'dark',
    variables: HASHIMOTO_YUNA,
    artwork: hashimotoYunaArtwork,
    artworkPosition: 'right center',
    artworkOpacity: 1,
    avatar: hashimotoYunaAvatar,
    avatarPosition: 'center 34%',
    quote: '黑樱桃香槟之夜 · Pi Agent',
  },
  {
    id: 'mikami-yua',
    labelKey: 'settings.theme.mikamiYua',
    hintKey: 'settings.theme.mikamiYuaHint',
    swatch: 'linear-gradient(135deg, #0b94d8 0%, #69c9f2 58%, #ffffff 58%, #f29aa2 100%)',
    colorScheme: 'light',
    variables: MIKAMI_YUA,
    artwork: mikamiYuaArtwork,
    artworkPosition: 'right center',
    artworkOpacity: 1,
    avatar: mikamiYuaAvatar,
    avatarPosition: 'center 34%',
    quote: '爱琴海珍珠假日 · Pi Agent',
  },
]

const THEME_BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]))
const STORAGE_KEY = 'pi-studio-theme'
const SYSTEM_QUERY = '(prefers-color-scheme: dark)'

function detectTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null && THEME_BY_ID.has(stored as ThemeId)) return stored as ThemeId
  } catch {
    // localStorage is unavailable in some embedded or privacy contexts.
  }
  return 'system'
}

let currentThemeId: ThemeId = 'system'
const themeChangeListeners = new Set<() => void>()

/** The currently selected theme id (module-level so i18n can flavor copy). */
export function getCurrentThemeId(): ThemeId {
  return currentThemeId
}

/** Subscribe to theme identity changes; returns an unsubscribe function. */
export function subscribeThemeId(listener: () => void): () => void {
  themeChangeListeners.add(listener)
  return () => {
    themeChangeListeners.delete(listener)
  }
}

function setCurrentThemeId(id: ThemeId): void {
  if (currentThemeId === id) return
  currentThemeId = id
  for (const listener of themeChangeListeners) listener()
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_QUERY).matches
}

export function getThemeDefinition(theme: ThemeId): ThemeDefinition {
  return THEME_BY_ID.get(theme) ?? THEMES[0]!
}

function applyTheme(theme: ThemeId): void {
  setCurrentThemeId(theme)
  if (typeof document === 'undefined') return

  const root = document.documentElement
  const definition = theme === 'system'
    ? (systemPrefersDark() ? getThemeDefinition('dark') : getThemeDefinition('light'))
    : getThemeDefinition(theme)

  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme

  for (const [name, value] of Object.entries(definition.variables)) root.style.setProperty(name, value)
  root.style.colorScheme = definition.colorScheme
  root.style.setProperty('--theme-artwork', definition.artwork === undefined ? 'none' : `url(${JSON.stringify(definition.artwork)})`)
  root.style.setProperty('--theme-artwork-position', definition.artworkPosition ?? 'center')
  root.style.setProperty('--theme-artwork-opacity', String(definition.artworkOpacity ?? 0))
  root.style.setProperty('--theme-avatar', definition.avatar === undefined ? 'none' : `url(${JSON.stringify(definition.avatar)})`)
  root.style.setProperty('--theme-avatar-position', definition.avatarPosition ?? 'center')
  root.style.setProperty('--theme-quote', definition.quote === undefined ? '""' : JSON.stringify(definition.quote))
}

interface ThemeContextValue {
  theme: ThemeId
  setTheme: (theme: ThemeId) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  setTheme: () => undefined,
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const initial = detectTheme()
    // Keep the module-level id in sync before the first render so themed
    // copy (THEME_COPY lookups) is correct even on the very first frame.
    currentThemeId = initial
    return initial
  })

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // The theme still applies for this session when persistence is blocked.
    }
  }, [])

  useLayoutEffect(() => {
    applyTheme(theme)

    if (theme !== 'system' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(SYSTEM_QUERY)
    const sync = () => applyTheme(theme)
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
