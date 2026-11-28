import { useState, type FormEvent, type ReactElement } from 'react'
import { Play, Trash2 } from 'lucide-react'
import type { RssSavedView } from '@shared/types'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { channelKey, parseChannelKey } from '@shared/rss/reading'
import { useRss } from './store'

export function RssSavedViews({ onClose }: { onClose?: () => void }): ReactElement {
  const saved = useSession(state => state.settings.rss.savedViews)
  const sortOrder = useSession(state => state.settings.rss.sortOrder)
  const update = useSession(state => state.updateSettings)
  const channel = useRss(state => state.channel)
  const currentView = useRss(state => state.views[channelKey(channel)])
  const view = currentView ?? { query: '', sort: sortOrder }
  const open = useRss(state => state.open)
  const setQuery = useRss(state => state.setQuery)
  const setSort = useRss(state => state.setSort)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const label = name.trim()
    if (!label || busy) return
    setBusy(true)
    setError('')
    const entry: RssSavedView = {
      id: crypto.randomUUID(),
      name: label.slice(0, 80),
      channel: channelKey(channel),
      query: view.query,
      sort: view.sort,
    }
    try {
      await update({ rss: { savedViews: [entry, ...saved].slice(0, 20) } })
      setName('')
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally { setBusy(false) }
  }

  const apply = async (entry: RssSavedView): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await open(parseChannelKey(entry.channel))
      setQuery(entry.query)
      setSort(entry.sort)
      if (onClose) onClose()
      else if (useUi.getState().panel === 'settings') useUi.getState().closePanel()
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally { setBusy(false) }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await update({ rss: { savedViews: saved.filter(entry => entry.id !== id) } })
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally { setBusy(false) }
  }

  return (
    <section>
      <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('rss.saved_views.title')}</h3>
      <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('rss.saved_views.desc')}</p>
      <form className="mt-3 flex items-end gap-2" onSubmit={event => void save(event)}>
        <Field label={t('rss.saved_views.name')} className="min-w-0 flex-1">
          <Input value={name} onChange={event => setName(event.target.value.slice(0, 80))} placeholder={t('rss.saved_views.placeholder')} />
        </Field>
        <Button type="submit" size="sm" loading={busy} disabled={!name.trim() || saved.length >= 20}>{t('rss.saved_views.save')}</Button>
      </form>
      {error && <p role="alert" className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}
      {saved.length ? (
        <ul className="mt-3 space-y-1">
          {saved.map(entry => (
            <li key={entry.id} className="flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{entry.name}</p>
                <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{entry.query || entry.channel}</p>
              </div>
              <IconButton label={t('rss.saved_views.apply', { name: entry.name })} size="xs" disabled={busy} onClick={() => void apply(entry)}><Play size={13}/></IconButton>
              <IconButton label={t('rss.saved_views.delete', { name: entry.name })} size="xs" disabled={busy} onClick={() => void remove(entry.id)}><Trash2 size={13}/></IconButton>
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('rss.saved_views.empty')}</p>}
    </section>
  )
}
