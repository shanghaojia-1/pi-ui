import { describe, expect, it } from 'vitest'
import { i18nKeys, translate } from '../../src/renderer/src/lib/i18n'
import { THEME_COPY, THEMES } from '../../src/renderer/src/lib/theme'

const PERSONA_THEMES = ['dongbei-yujie', 'hashimoto-yuna', 'mikami-yua'] as const

describe('i18n dictionary', () => {
  it('every key has both zh and en translations', () => {
    for (const key of i18nKeys()) {
      const zh = translate('zh', key)
      const en = translate('en', key)
      expect(zh, `zh missing for ${key}`).not.toBe(key)
      expect(en, `en missing for ${key}`).not.toBe(key)
      expect(zh.length).toBeGreaterThan(0)
      expect(en.length).toBeGreaterThan(0)
    }
  })

  it('translates known keys in both languages', () => {
    expect(translate('zh', 'sidebar.newTask')).toBe('新任务')
    expect(translate('en', 'sidebar.newTask')).toBe('New Task')
    expect(translate('zh', 'settings.theme.dongbeiYujie')).toBe('东北雨姐')
    expect(translate('en', 'settings.theme.dongbeiYujie')).toBe('Dongbei Yujie')
    expect(translate('en', 'composer.hint.idle')).toContain('Enter send')
  })

  it('interpolates variables and falls back to the key for unknown keys', () => {
    expect(translate('zh', 'sidebar.messages', { n: 3 })).toBe('3 条消息')
    expect(translate('en', 'settings.timeoutInvalid', { min: 1, max: 600 })).toBe(
      'HTTP idle timeout must be between 1–600s',
    )
    expect(translate('zh', 'no.such.key')).toBe('no.such.key')
  })

  it('slash command descriptions and groups exist in both languages', () => {
    for (const key of [
      'composer.slash.new',
      'composer.slash.compact',
      'composer.slash.groupSession',
      'composer.slash.groupConfig',
      'composer.slash.groupSystem',
    ]) {
      expect(translate('zh', key)).not.toBe(key)
      expect(translate('en', key)).not.toBe(key)
    }
  })
})

describe('theme catalog', () => {
  it('offers system + five explicit themes (persona themes last)', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['system', 'light', 'dark', 'dongbei-yujie', 'hashimoto-yuna', 'mikami-yua'])
  })

  it('every theme has a translated label and a swatch', () => {
    for (const theme of THEMES) {
      expect(translate('zh', theme.labelKey), theme.id).not.toBe(theme.labelKey)
      expect(translate('en', theme.labelKey), theme.id).not.toBe(theme.labelKey)
      expect(theme.swatch.length).toBeGreaterThan(0)
    }
    const dongbeiYujie = THEMES.find((theme) => theme.id === 'dongbei-yujie')
    expect(dongbeiYujie?.hintKey).toBe('settings.theme.dongbeiYujieHint')
    expect(dongbeiYujie?.quote).toBe('带派不老铁 · Pi Agent')
    expect(dongbeiYujie?.artwork).toContain('dongbei-yujie-theme.png')
    expect(dongbeiYujie?.avatar).toContain('dongbei-yujie-avatar.png')
    const hashimotoYuna = THEMES.find((theme) => theme.id === 'hashimoto-yuna')
    expect(hashimotoYuna?.hintKey).toBe('settings.theme.hashimotoYunaHint')
    expect(hashimotoYuna?.artwork).toContain('hashimoto-yuna-theme-v2.png')
    expect(hashimotoYuna?.avatar).toContain('hashimoto-yuna-avatar.png')
    expect(hashimotoYuna?.colorScheme).toBe('dark')
    const mikamiYua = THEMES.find((theme) => theme.id === 'mikami-yua')
    expect(mikamiYua?.hintKey).toBe('settings.theme.mikamiYuaHint')
    expect(mikamiYua?.artwork).toContain('mikami-yua-theme.png')
    expect(mikamiYua?.avatar).toContain('mikami-yua-avatar.png')
    expect(mikamiYua?.colorScheme).toBe('light')
  })
})

describe('theme copy (persona flavor texts)', () => {
  it('covers the same experience keys for every persona theme', () => {
    const reference = Object.keys(THEME_COPY['dongbei-yujie'] ?? {})
    expect(reference.length).toBeGreaterThan(60)
    for (const theme of PERSONA_THEMES) {
      const copy = THEME_COPY[theme]
      expect(copy, theme).toBeDefined()
      expect(Object.keys(copy ?? {}).sort()).toEqual([...reference].sort())
    }
  })

  it('every themed entry has both zh and en, and both differ from the base dict', () => {
    for (const theme of PERSONA_THEMES) {
      for (const [key, entry] of Object.entries(THEME_COPY[theme] ?? {})) {
        expect(entry.zh, `${theme}.${key}`).not.toBe(entry.en)
        expect(entry.zh.length, `${theme}.${key}`).toBeGreaterThan(0)
        expect(entry.en.length, `${theme}.${key}`).toBeGreaterThan(0)
        expect(translate('zh', key), `${theme}.${key} zh`).not.toBe(translate('zh', key, undefined, theme))
        expect(translate('en', key), `${theme}.${key} en`).not.toBe(translate('en', key, undefined, theme))
      }
    }
  })

  it('keeps the placeholders used by the base entries', () => {
    for (const theme of PERSONA_THEMES) {
      for (const [key, entry] of Object.entries(THEME_COPY[theme] ?? {})) {
        const base = translate('zh', key)
        const placeholders = [...base.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1])
        for (const ph of placeholders) {
          expect(entry.zh, `${theme}.${key} zh`).toContain(`{${ph}}`)
          expect(entry.en, `${theme}.${key} en`).toContain(`{${ph}}`)
        }
      }
    }
  })

  it('flavors the key experience strings per persona', () => {
    expect(translate('zh', 'messages.welcome.title', undefined, 'dongbei-yujie')).toBe('开整新活儿！')
    expect(translate('en', 'sidebar.newTask', undefined, 'dongbei-yujie')).toBe('Fresh task')
    expect(translate('zh', 'messages.welcome.title', undefined, 'hashimoto-yuna')).toBe('今夜，别急着睡')
    expect(translate('zh', 'composer.slash.new', undefined, 'mikami-yua')).toBe('开启新的一夜（新会话）')
    expect(translate('en', 'messages.welcome.title', undefined, 'mikami-yua')).toBe('Want me to start a new task with you?')
  })

  it('welcome desc pieces stay grammatical around the workspace name', () => {
    for (const theme of PERSONA_THEMES) {
      const zh = translate('zh', 'messages.welcome.desc', undefined, theme) + 'my-app' + translate('zh', 'messages.welcome.desc2', undefined, theme)
      const en = translate('en', 'messages.welcome.desc', undefined, theme) + ' my-app ' + translate('en', 'messages.welcome.desc2', undefined, theme)
      expect(zh.length).toBeGreaterThan(10)
      expect(en.length).toBeGreaterThan(10)
    }
  })
})
