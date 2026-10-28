import { useState } from 'react'
import { ArrowRight, Check, Copy, Info, SquareTerminal, X } from 'lucide-react'
import type { XgetPlatform } from '@shared/development/xget/catalog'
import { t } from '../../../../lib/i18n'
import { copyText } from '../../../../lib/clipboard'
import { Button, Divider, IconButton } from '../../../../components/primitives'
import { Drawer } from '../../../../components/overlay'
import { useUiStore } from '../../../../lib/ui-store'
import { buildProxyUrl } from '../utils/commands'
import { getPlatformGuide, renderGuideCommand } from '../utils/platform-guides'
import { PlatformBadge } from './PlatformBadge'
import { PlatformIcon } from './PlatformIcon'

export function PlatformDetail({
  open,
  platform,
  proxyBase,
  onOpenChange,
}: {
  open: boolean
  platform: XgetPlatform | null
  proxyBase: string
  onOpenChange: (open: boolean) => void
}) {
  const [copiedKey, setCopiedKey] = useState('')
  if (!platform) return null

  const guide = getPlatformGuide(platform.key, platform.name)
  const originalExample = `${platform.hosts[0]}${platform.example}`
  const acceleratedExample = buildProxyUrl(proxyBase, platform.key, platform.example)
  const renderCmd = (value: string) => renderGuideCommand(value, proxyBase)

  async function copy(value: string, key: string): Promise<void> {
    const ok = await copyText(value)
    if (!ok) {
      useUiStore.getState().toast(t('development.xget.common.copy_failed'), 'error')
      return
    }
    setCopiedKey(key)
    useUiStore.getState().toast(t('development.xget.common.copied'), 'success')
    window.setTimeout(() => setCopiedKey(''), 1500)
  }

  return (
    <Drawer
      open={open}
      onClose={() => onOpenChange(false)}
      side="right"
      width={440}
      ariaLabel={platform.name}
      bodyClassName="p-0"
    >
      <header className="relative shrink-0 border-b border-[var(--border-subtle)] px-4 py-3.5 pr-12">
        <div className="flex items-center gap-2">
          <PlatformIcon platformKey={platform.key} category={platform.category} />
          <h2 className="min-w-0 truncate text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
            {platform.name}
          </h2>
          <PlatformBadge platformKey={platform.key} category={platform.category} size="sm" />
          <IconButton
            label={t('development.xget.platforms.close')}
            size="sm"
            onClick={() => onOpenChange(false)}
            className="absolute top-3 right-3"
          >
            <X size={15} />
          </IconButton>
        </div>
        <p className="mt-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">{t(guide.summaryKey, { name: platform.name })}</p>
        <p className="mt-0.5 font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">{platform.hosts[0]}</p>
      </header>

      <div className="border-b border-[var(--border-subtle)] px-4 py-3">
        <p className="flex items-center gap-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          <Info size={14} />
          {t('development.xget.platforms.detail_format')}
        </p>
        <code className="mt-1.5 block truncate rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-2.5 py-1.5 font-mono text-[length:var(--text-11)] text-[var(--text-primary)]">
          {renderCmd(guide.format)}
        </code>
      </div>

      <div className="border-b border-[var(--border-subtle)] px-4 py-3">
        <p className="flex items-center gap-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          <ArrowRight size={14} />
          {t('development.xget.platforms.detail_example')}
        </p>
        <div className="mt-1.5 space-y-1.5">
          <div className="truncate rounded-[var(--r-md)] bg-[var(--bg-raised)] px-2.5 py-1.5 font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]" title={originalExample}>
            {originalExample}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1 truncate rounded-[var(--r-md)] border border-[var(--accent)] bg-[var(--accent-softer)] px-2.5 py-1.5 font-mono text-[length:var(--text-11)] text-[var(--accent)]" title={acceleratedExample}>
              {acceleratedExample}
            </div>
            <Button variant="ghost" size="sm" aria-label={t('development.xget.common.copy')} onClick={() => void copy(acceleratedExample, 'example')} className="h-7 shrink-0 px-1.5">
              {copiedKey === 'example' ? <Check size={14} className="text-[var(--success)]" /> : <Copy size={14} />}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-3">
        <p className="mb-2 flex items-center gap-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          <SquareTerminal size={14} />
          {t('development.xget.platforms.detail_guide')}
        </p>
        <div className="space-y-3">
          {guide.sections.map((section, si) => (
            <section key={si}>
              <h3 className="mb-1 text-[length:var(--text-11)] font-semibold text-[var(--text-primary)]">{t(section.titleKey)}</h3>
              <div className="space-y-1.5">
                {section.commands.map((command, ci) => {
                  const key = `cmd-${si}-${ci}`
                  return (
                    <div key={key} className="group relative rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)]">
                      {command.labelKey && (
                        <div className="px-2.5 pt-1.5 text-[length:var(--text-10)] font-medium text-[var(--text-tertiary)]">
                          {t(command.labelKey)}
                        </div>
                      )}
                      <pre className="overflow-x-auto px-2.5 py-2 pr-9 font-mono text-[length:var(--text-11)] leading-relaxed whitespace-pre-wrap break-words text-[var(--text-primary)]">
                        {renderCmd(command.cmd)}
                      </pre>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('development.xget.common.copy')}
                        onClick={() => void copy(renderCmd(command.cmd), key)}
                        className="absolute top-1/2 right-1 h-6 -translate-y-1/2 px-1.5 text-[var(--text-tertiary)]"
                      >
                        {copiedKey === key ? <Check size={13} className="text-[var(--success)]" /> : <Copy size={13} />}
                      </Button>
                    </div>
                  )
                })}
              </div>
              {section.noteKey && <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t(section.noteKey)}</p>}
            </section>
          ))}
        </div>
      </div>

      <Divider />
      <footer className="sticky bottom-0 flex items-center gap-2 bg-[var(--bg-surface)] px-4 py-3">
        <Button variant="secondary" size="sm" icon={<Copy size={13} />} onClick={() => void copy(renderCmd(guide.format), 'format')} className="h-8 flex-1 text-[length:var(--text-12)]">
          {t('development.xget.platforms.copy_format')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => onOpenChange(false)} className="h-8 flex-1 text-[length:var(--text-12)]">
          {t('development.xget.platforms.close')}
        </Button>
      </footer>
    </Drawer>
  )
}
