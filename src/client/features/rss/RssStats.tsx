import { useEffect, useState, type ReactElement } from 'react'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'

interface Stats {
  total: number
  read: number
  unread: number
  favorites: number
  later: number
  daily: Array<{ date: string, count: number }>
}

export function RssStats(): ReactElement {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    void api.rss.stats().then(setStats).catch((cause: unknown) => {
      console.warn('[inkstone] RSS reading stats could not be loaded', cause)
      setError(true)
    })
  }, [])

  if (error) return <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">{t('rss.stats.failed')}</p>
  if (!stats) return <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('common.loading')}</p>
  const max = Math.max(1, ...stats.daily.map(day => day.count))
  const cards: Array<[string, number]> = [
    [t('rss.stats.total'), stats.total],
    [t('rss.stats.read'), stats.read],
    [t('rss.stats.unread'), stats.unread],
    [t('rss.stats.favorites'), stats.favorites],
    [t('rss.stats.later'), stats.later],
  ]
  return (
    <section>
      <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('rss.stats.title')}</h3>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cards.map(([label, value]) => (
          <div key={label} className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-2 py-2">
            <p className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{label}</p>
            <p className="mt-0.5 text-[length:var(--text-15)] font-semibold tabular-nums text-[var(--text-primary)]">{value}</p>
          </div>
        ))}
      </div>
      {stats.daily.length > 0 && (
        <div className="mt-3 flex h-20 items-end gap-1" aria-label={t('rss.stats.week')}>
          {stats.daily.map(day => (
            <div key={day.date} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${day.date}: ${day.count}`}>
              <div className="w-full rounded-t-[var(--r-sm)] bg-[var(--accent)]" style={{ height: `${Math.max(4, day.count / max * 100)}%` }} />
              <span className="text-[length:var(--text-9)] text-[var(--text-quaternary)]">{day.date.slice(5)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
