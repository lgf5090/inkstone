import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/inter.css'
import './styles/app.css'
import { LOCALE_STORAGE_KEY, UI_STORAGE_KEY } from './lib/runtime'
import { installViewportSizing } from './lib/viewport'
import { reportBootFailure, reportBootReady } from './lib/boot'

installViewportSizing()

async function start(): Promise<void> {
  if (import.meta.env.MODE === 'demo') {
    localStorage.removeItem(UI_STORAGE_KEY)
    localStorage.removeItem(LOCALE_STORAGE_KEY)
    const { installDemoRuntime } = await import('./demo/runtime')
    await installDemoRuntime()
  }

  const [{ App }, i18n] = await Promise.all([import('./App'), import('./lib/i18n')])
  await i18n.initI18n()
  const container = document.getElementById('root')
  if (!container) throw new Error(i18n.t("app.missing_root_mount_point"))
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// Every import above `createRoot` is a request for a content-hashed file. After a deploy the names
// in this document are the previous build's, so a rejected import has to reach the recovery in
// `boot.ts` — the overlay is otherwise the last thing the page ever shows.
start().then(reportBootReady).catch(reportBootFailure)
