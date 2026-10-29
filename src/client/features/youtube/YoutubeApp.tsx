/**
 * The YouTube tab. The P0 shell only proves the address wiring and the lazy container; the sidebar,
 * list and detail are filled in by the D/E/F slices.
 */
import { useEffect } from 'react'
import { PlaySquare } from 'lucide-react'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { useYouTubeAddress } from './address'
import { useYoutubeStore } from './store'

export function YoutubeApp() {
  const address = useYouTubeAddress()
  const ensureLibrary = useYoutubeStore((state) => state.ensureLibrary)

  useEffect(() => {
    if (!IS_DEMO_MODE) ensureLibrary()
  }, [ensureLibrary])

  if (IS_DEMO_MODE) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('youtube.demo_unavailable')}
      </div>
    )
  }

  return (
    <div data-youtube-app="" className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <span className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
          <PlaySquare size={16} />
        </span>
        <h1 className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('app.tabs.youtube')}
        </h1>
        <span className="ml-auto text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {address.view.kind}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('common.loading')}
      </div>
    </div>
  )
}
