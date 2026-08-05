import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeId = 'system' | 'light' | 'dark' | 'sepia' | 'ocean' | 'forest'

export const THEMES: { id: ThemeId; labelKey: string; swatch: string }[] = [
  { id: 'system', labelKey: 'settings.theme.system', swatch: 'linear-gradient(135deg, #f6f4f1 50%, #1d1c1a 50%)' },
  { id: 'light', labelKey: 'settings.theme.light', swatch: '#f6f4f1' },
  { id: 'dark', labelKey: 'settings.theme.dark', swatch: '#1d1c1a' },
  { id: 'sepia', labelKey: 'settings.theme.sepia', swatch: '#f3ead8' },
  { id: 'ocean', labelKey: 'settings.theme.ocean', swatch: '#0f2438' },
  { id: 'forest', labelKey: 'settings.theme.forest', swatch: '#eef3ea' },
]

/**
 * Theme selection:
 * - 'system': follow the OS via prefers-color-scheme (no data-theme attribute;
 *   the CSS `:root:not([data-theme])` media query decides light/dark).
 * - any other id: set `data-theme` on <html>; CSS `[data-theme='id']` blocks
 *   override every variable, and the media query no longer applies because
 *   the attribute is present.
 * Persisted in localStorage (UI preference, not a Pi setting).
 */
const STORAGE_KEY = 'pi-studio-theme'

function detectTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null && THEMES.some((t) => t.id === stored)) return stored as ThemeId
  } catch { /* ignore */ }
  return 'system'
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
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    const el = document.documentElement
    if (theme === 'system') delete el.dataset.theme
    else el.dataset.theme = theme
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
