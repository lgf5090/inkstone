import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'

interface Rule {
  id: string
  feedId: string
  keyword: string
  enabled: boolean
  createdAt: number
}

export function RssRules(): ReactElement {
  const [rules, setRules] = useState<Rule[]>([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void api.rss.rules().then(result => setRules(result.rules)).catch((cause: unknown) => {
      console.warn('[inkstone] RSS rules could not be loaded', cause)
      setError(t('rss.rules.load_failed'))
    }).finally(() => setLoading(false))
  }, [])

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const term = keyword.trim()
    if (!term || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api.rss.addRule(term)
      setRules(current => [result.rule, ...current])
      setKeyword('')
    }
    catch (cause) {
      console.warn('[inkstone] RSS rule could not be created', cause)
      setError(t('rss.rules.save_failed'))
    }
    finally { setBusy(false) }
  }

  const remove = async (id: string): Promise<void> => {
    setError('')
    try {
      await api.rss.deleteRule(id)
      setRules(current => current.filter(rule => rule.id !== id))
    }
    catch (cause) {
      console.warn('[inkstone] RSS rule could not be deleted', cause)
      setError(t('rss.rules.save_failed'))
    }
  }

  return (
    <section>
      <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('rss.rules.title')}</h3>
      <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('rss.rules.desc')}</p>
      <form className="mt-3 flex items-center gap-2" onSubmit={event => void add(event)}>
        <Input value={keyword} onChange={event => setKeyword(event.target.value.slice(0, 80))} placeholder={t('rss.rules.placeholder')} aria-label={t('rss.rules.placeholder')} />
        <Button type="submit" size="sm" loading={busy} disabled={!keyword.trim()}>{t('rss.rules.add')}</Button>
      </form>
      {error && <p role="alert" className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}
      {loading ? (
        <p className="mt-3 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('common.loading')}</p>
      ) : rules.length ? (
        <ul className="mt-3 space-y-1">
          {rules.map(rule => (
            <li key={rule.id} className="flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{rule.keyword}</span>
              <IconButton label={t('rss.rules.delete', { keyword: rule.keyword })} size="xs" onClick={() => void remove(rule.id)}>
                <Trash2 size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('rss.rules.empty')}</p>
      )}
    </section>
  )
}
