import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, watchTheme } from './theme/theme'

// public/theme-init.js already set the theme before paint; this keeps it in
// step with the system setting and other tabs from now on.
applyTheme()
watchTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
