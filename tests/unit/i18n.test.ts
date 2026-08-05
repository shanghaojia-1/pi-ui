import { describe, expect, it } from 'vitest'
import { i18nKeys, translate } from '../../src/renderer/src/lib/i18n'
import { THEMES } from '../../src/renderer/src/lib/theme'

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
    expect(translate('zh', 'settings.theme.sepia')).toBe('羊皮纸')
    expect(translate('en', 'settings.theme.sepia')).toBe('Sepia')
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
  it('offers system + five explicit themes', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['system', 'light', 'dark', 'sepia', 'ocean', 'forest'])
  })

  it('every theme has a translated label and a swatch', () => {
    for (const theme of THEMES) {
      expect(translate('zh', theme.labelKey), theme.id).not.toBe(theme.labelKey)
      expect(translate('en', theme.labelKey), theme.id).not.toBe(theme.labelKey)
      expect(theme.swatch.length).toBeGreaterThan(0)
    }
  })
})
