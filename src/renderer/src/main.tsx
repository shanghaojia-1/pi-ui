import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './lib/i18n'
import { ThemeProvider } from './lib/theme'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

createRoot(rootEl).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
)
