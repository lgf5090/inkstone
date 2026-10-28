import { History, Trash2 } from 'lucide-react'
import { XGET_PLATFORM_BY_KEY } from '@shared/development/xget/catalog'
import { t } from '../../../../lib/i18n'
import { fullTime, shortTime } from '../../../../lib/time'
import { Button } from '../../../../components/primitives'
import { confirm } from '../../../../components/overlay'
import type { XgetHistoryItem } from '../lib/history'
import { PlatformIcon } from './PlatformIcon'

export function HistoryCard({
  history,
  onReuse,
  onClear,
}: {
  history: XgetHistoryItem[]
  onReuse: (item: XgetHistoryItem) => void
  onClear: () => void
}) {
  if (history.length === 0) return null

  async function clear(): Promise<void> {
    if (await confirm({ title: t('development.xget.converter.clear_history'), description: t('development.xget.converter.clear_confirm'), tone: 'danger' })) {
      onClear()
    }
  }

  return (
    <section className="mt-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <h2 className="flex items-center gap-2 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          <History size={15} className="text-[var(--accent)]" />
          {t('development.xget.converter.history')}
        </h2>
        <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => void clear()} className="h-7 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('development.xget.converter.clear_history')}
        </Button>
      </header>
      <div className="max-h-44 space-y-1.5 overflow-y-auto p-2">
        {history.map((item) => {
          const platform = XGET_PLATFORM_BY_KEY[item.key as keyof typeof XGET_PLATFORM_BY_KEY]
          return (
            <button
              key={`${item.time}-${item.result}`}
              type="button"
              onClick={() => onReuse(item)}
              className="flex w-full items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
            >
              <PlatformIcon
                platformKey={item.key}
                category={platform?.category ?? 'misc'}
                size="sm"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">
                  {item.result}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <span className="font-mono">{item.key}</span>
                  <span title={fullTime(item.time)}>{shortTime(item.time)}</span>
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
