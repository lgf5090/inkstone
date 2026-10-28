import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { XgetPlatform, XgetPlatformKey } from '@shared/development/xget/catalog'
import { t } from '../../../../lib/i18n'
import { copyText } from '../../../../lib/clipboard'
import { Button } from '../../../../components/primitives'
import { useUiStore } from '../../../../lib/ui-store'
import { buildProxyUrl } from '../utils/commands'
import { PLATFORM_DESCRIPTION_KEYS } from '../utils/platform-meta'
import { PlatformBadge } from './PlatformBadge'
import { PlatformIcon } from './PlatformIcon'

export function PlatformCard({
  platform,
  proxyBase,
  onOpen,
}: {
  platform: XgetPlatform
  proxyBase: string
  onOpen: (platform: XgetPlatform) => void
}) {
  const [copied, setCopied] = useState(false)
  const acceleratedExample = buildProxyUrl(proxyBase, platform.key, platform.example)

  async function copy(): Promise<void> {
    const ok = await copyText(acceleratedExample)
    if (!ok) {
      useUiStore.getState().toast(t('development.xget.common.copy_failed'), 'error')
      return
    }
    setCopied(true)
    useUiStore.getState().toast(t('development.xget.common.copied'), 'success')
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <article className="group flex min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] transition-colors hover:border-[var(--accent)]">
      <button
        type="button"
        onClick={() => onOpen(platform)}
        aria-label={t('development.xget.platforms.open_detail', { name: platform.name })}
        className="flex min-w-0 flex-1 flex-col gap-2 rounded-t-[var(--r-lg)] p-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <PlatformIcon platformKey={platform.key} category={platform.category} />
            <span className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {platform.name}
            </span>
          </span>
          <PlatformBadge platformKey={platform.key} category={platform.category} size="sm" />
        </span>
        <span className="truncate font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]" title={platform.hosts.join(', ')}>
          {platform.hosts[0]}
        </span>
        <span className="truncate text-[length:var(--text-12)] text-[var(--text-secondary)]" title={t(PLATFORM_DESCRIPTION_KEYS[platform.key as XgetPlatformKey])}>
          {t(PLATFORM_DESCRIPTION_KEYS[platform.key as XgetPlatformKey])}
        </span>
      </button>
      <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]" title={`${platform.hosts[0]}${platform.example}`}>
          {platform.example}
        </code>
        <Button
          variant="ghost"
          size="sm"
          icon={copied ? <Check size={13} className="text-[var(--success)]" /> : <Copy size={13} />}
          onClick={() => void copy()}
          title={t('development.xget.platforms.copy_hint')}
          className="h-7 shrink-0 px-2 text-[length:var(--text-12)]"
        >
          {copied ? t('development.xget.platforms.copied') : t('development.xget.platforms.copy_url')}
        </Button>
      </div>
    </article>
  )
}
