/**
 * The AI workspace: five tabs under one address.
 *
 * The tab is the query rather than local state, so a reader can paste the address of the tab they
 * mean and the back button walks the tabs they visited.
 */
import { useEffect } from 'react'
import { cn } from '../../../lib/cn'
import { currentSearch, navigateToAddress, replaceAddress } from '../../../lib/app-history'
import {
  CLOUDFLARE_AI_TABS,
  cloudflareScreenPath,
  type CloudflareAiTab,
} from '../cloudflare-address'
import { useCfT, type CloudflareMessageKey } from '../i18n'
import { StatsTab } from './ai/StatsTab'
import { ChatTab } from './ai/ChatTab'
import { ImageTab } from './ai/ImageTab'
import { AudioTab } from './ai/AudioTab'
import { TranslateTab } from './ai/TranslateTab'

const TAB_LABELS: Record<CloudflareAiTab, CloudflareMessageKey> = {
  stats: 'cloudflare.ai_tabs.stats',
  chat: 'cloudflare.ai_tabs.chat',
  image: 'cloudflare.ai_tabs.image',
  audio: 'cloudflare.ai_tabs.audio',
  translate: 'cloudflare.ai_tabs.translate',
}

function AiTabPanel({ tab }: { tab: CloudflareAiTab }) {
  switch (tab) {
    case 'chat': return <ChatTab />
    case 'image': return <ImageTab />
    case 'audio': return <AudioTab />
    case 'translate': return <TranslateTab />
    default: return <StatsTab />
  }
}

export function AiScreen({ tab }: { tab: CloudflareAiTab }) {
  const t = useCfT()
  const aiPath = cloudflareScreenPath('ai')

  // The default tab still names itself in the address, so every view here can be shared.
  useEffect(() => {
    if (new URLSearchParams(currentSearch()).has('tab')) return
    replaceAddress(aiPath, `tab=${tab}`)
  }, [aiPath, tab])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {t('cloudflare.ai.title')}
        </h1>
      </header>
      <nav aria-label={t('cloudflare.ai.title')} className="flex flex-wrap gap-1 border-b border-[var(--border-subtle)] px-3 pt-2">
        {CLOUDFLARE_AI_TABS.map((entry) => {
          const active = entry === tab
          return (
            <a
              key={entry}
              href={`${aiPath}?tab=${entry}`}
              aria-current={active ? 'page' : undefined}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                if (!active) navigateToAddress(aiPath, `tab=${entry}`)
              }}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[length:var(--text-12-5)] transition-colors duration-[var(--dur-fast)]',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
                active
                  ? 'border-[var(--accent)] font-medium text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
              )}
            >
              {t(TAB_LABELS[entry])}
            </a>
          )
        })}
      </nav>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AiTabPanel tab={tab} />
      </div>
    </div>
  )
}
