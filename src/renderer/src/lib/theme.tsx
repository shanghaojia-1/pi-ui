import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import dongbeiYujieArtwork from '../assets/dongbei-yujie-theme.png'

export type ThemeId = 'system' | 'light' | 'dark' | 'sepia' | 'ocean' | 'forest' | 'dongbei-yujie'

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

const SEPIA: ThemeVariables = {
  '--bg': '#f3ead8',
  '--bg-panel': '#f8f1e2',
  '--bg-elevated': '#fdf8ec',
  '--bg-subtle': '#ede2cb',
  '--bg-hover': '#e7d9bd',
  '--bg-active': '#dfcfae',
  '--border': '#e0d2b4',
  '--border-strong': '#c8b78e',
  '--text': '#3d3627',
  '--text-2': '#7c7157',
  '--text-3': '#a89b7c',
  '--text-3-strong': '#948763',
  '--accent': '#9c5a2b',
  '--accent-strong': '#7f471f',
  '--accent-soft': '#f0e2cc',
  '--green': '#5f7040',
  '--green-soft': '#e6e8d2',
  '--red': '#a3482f',
  '--red-soft': '#f0ddd4',
  '--amber': '#93711e',
  '--amber-soft': '#efe6c6',
  '--blue': '#48697d',
  '--blue-soft': '#dde6e9',
}

const OCEAN: ThemeVariables = {
  '--bg': '#0e1e2f',
  '--bg-panel': '#122437',
  '--bg-elevated': '#162a3f',
  '--bg-subtle': '#1a3048',
  '--bg-hover': '#1f3751',
  '--bg-active': '#253f5c',
  '--border': '#233b55',
  '--border-strong': '#31506f',
  '--text': '#dbe7f2',
  '--text-2': '#93a8bd',
  '--text-3': '#5d748c',
  '--text-3-strong': '#7890a8',
  '--accent': '#4fa3d9',
  '--accent-strong': '#7cc0ea',
  '--accent-soft': '#17324a',
  '--green': '#6fbf8f',
  '--green-soft': '#152e24',
  '--red': '#e07a6a',
  '--red-soft': '#3a2320',
  '--amber': '#d4ab4f',
  '--amber-soft': '#332b17',
  '--blue': '#6fa8d9',
  '--blue-soft': '#15283c',
}

const FOREST: ThemeVariables = {
  '--bg': '#eef3ea',
  '--bg-panel': '#f6f9f3',
  '--bg-elevated': '#fdfefb',
  '--bg-subtle': '#e4ecdf',
  '--bg-hover': '#dce7d5',
  '--bg-active': '#d3e0ca',
  '--border': '#d8e2d0',
  '--border-strong': '#bfd0b3',
  '--text': '#28302a',
  '--text-2': '#5f6f5d',
  '--text-3': '#93a38f',
  '--text-3-strong': '#7d8d78',
  '--accent': '#4f7a3f',
  '--accent-strong': '#3d622f',
  '--accent-soft': '#e2eedb',
  '--green': '#4d7c4f',
  '--green-soft': '#e2efe0',
  '--red': '#a8482f',
  '--red-soft': '#f0e0d8',
  '--amber': '#96811f',
  '--amber-soft': '#efe9cc',
  '--blue': '#46738f',
  '--blue-soft': '#dfeaf0',
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

/**
 * The theme catalog is the single source of truth for labels, swatches,
 * tokens, and optional artwork. Adding a theme should only require one
 * definition here plus its translations.
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
  { id: 'sepia', labelKey: 'settings.theme.sepia', swatch: '#f3ead8', colorScheme: 'light', variables: SEPIA },
  { id: 'ocean', labelKey: 'settings.theme.ocean', swatch: '#0f2438', colorScheme: 'dark', variables: OCEAN },
  { id: 'forest', labelKey: 'settings.theme.forest', swatch: '#eef3ea', colorScheme: 'light', variables: FOREST },
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
    quote: '带派不老铁',
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

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_QUERY).matches
}

function findTheme(theme: ThemeId): ThemeDefinition {
  return THEME_BY_ID.get(theme) ?? THEMES[0]!
}

function applyTheme(theme: ThemeId): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  const definition = theme === 'system'
    ? (systemPrefersDark() ? findTheme('dark') : findTheme('light'))
    : findTheme(theme)

  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme

  for (const [name, value] of Object.entries(definition.variables)) root.style.setProperty(name, value)
  root.style.colorScheme = definition.colorScheme
  root.style.setProperty('--theme-artwork', definition.artwork === undefined ? 'none' : `url(${JSON.stringify(definition.artwork)})`)
  root.style.setProperty('--theme-artwork-position', definition.artworkPosition ?? 'center')
  root.style.setProperty('--theme-artwork-opacity', String(definition.artworkOpacity ?? 0))
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
  const [theme, setThemeState] = useState<ThemeId>(detectTheme)

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
