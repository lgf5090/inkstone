import { useCallback, useEffect, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { TaxonomyItem, TaxonomyKind } from '@shared/blog/model'
import { Badge, Button } from '../../components/primitives'
import { Field, Input, Select, Textarea } from '../../components/form'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { AdminEmpty, AdminError, AdminLoading, PageHeader, TabBar } from './shared'

const TABS: { kind: TaxonomyKind; label: MessageKey }[] = [
  { kind: 'categories', label: 'blog.admin.categories' },
  { kind: 'tags', label: 'blog.admin.tags' },
  { kind: 'series', label: 'blog.admin.series' },
]

interface FormState {
  id: string | null
  name: string
  slug: string
  description: string
  color: string
  status: string
}

const EMPTY_FORM: FormState = { id: null, name: '', slug: '', description: '', color: '', status: 'ongoing' }

export function TaxonomyPanel({ initialKind = 'categories' }: { initialKind?: TaxonomyKind } = {}) {
  const [kind, setKind] = useState<TaxonomyKind>(initialKind)
  const [data, setData] = useState<Record<TaxonomyKind, TaxonomyItem[]>>({ categories: [], tags: [], series: [] })
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api.blog.taxonomy.list())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setForm(EMPTY_FORM)
    setError('')
  }, [kind])

  const items = data[kind]
  const editing = form.id !== null

  const edit = (item: TaxonomyItem) => {
    setForm({
      id: item.id,
      name: item.name,
      slug: item.slug,
      description: item.description,
      color: item.color ?? '',
      status: item.status,
    })
  }

  const save = async () => {
    if (!form.name.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      const input = {
        name: form.name,
        slug: form.slug || undefined,
        description: form.description,
        color: kind === 'tags' ? form.color || null : null,
        status: kind === 'series' ? form.status : undefined,
      }
      if (form.id) await api.blog.taxonomy.update(kind, form.id, input)
      else await api.blog.taxonomy.create(kind, input)
      setForm(EMPTY_FORM)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (item: TaxonomyItem) => {
    const ok = await confirm({
      title: t('blog.admin.taxonomy_delete_title'),
      description: t('blog.admin.taxonomy_delete_desc'),
      confirmLabel: t('blog.admin.taxonomy_delete'),
      tone: 'danger',
    })
    if (!ok) return
    setError('')
    try {
      await api.blog.taxonomy.remove(kind, item.id)
      if (form.id === item.id) setForm(EMPTY_FORM)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title={t(TABS.find((tab) => tab.kind === kind)!.label)} description={t('blog.admin.taxonomy_subtitle')} />
      <TabBar
        tabs={TABS.map((tab) => ({ id: tab.kind, label: t(tab.label), count: data[tab.kind].length }))}
        value={kind}
        onChange={setKind}
        label={t('blog.admin.taxonomy')}
      />
      <section className="mt-4 grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        {error && <AdminError message={error} onRetry={() => void load()} />}

        {loading && items.length === 0 ? (
          <AdminLoading />
        ) : items.length === 0 ? (
          <AdminEmpty>{t('blog.admin.taxonomy_empty')}</AdminEmpty>
        ) : (
          <div className="overflow-x-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <table className="w-full min-w-[560px] border-collapse text-left text-[length:var(--text-12-5)]">
              <caption className="sr-only">{t(TABS.find((tab) => tab.kind === kind)!.label)}</caption>
              <thead className="border-b border-[var(--border-subtle)] text-[length:var(--text-11)] tracking-wide text-[var(--text-tertiary)] uppercase">
                <tr>
                  <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.taxonomy_name')}</th>
                  <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.taxonomy_slug')}</th>
                  <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.taxonomy_count')}</th>
                  {kind === 'series' && <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.taxonomy_status')}</th>}
                  <th scope="col" className="px-3 py-3 text-right font-medium">{t('blog.admin.column_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
                        {item.color && <span className="size-2.5 rounded-full" style={{ background: item.color }} />}
                        {item.name}
                      </span>
                      {item.description && <p className="mt-0.5 line-clamp-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{item.description}</p>}
                    </td>
                    <td className="px-3 py-3 font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">{item.slug}</td>
                    <td className="px-3 py-3 tabular-nums text-[var(--text-secondary)]">{item.count}</td>
                    {kind === 'series' && <td className="px-3 py-3"><Badge tone={item.status === 'completed' ? 'success' : 'accent'}>{item.status === 'completed' ? t('blog.admin.taxonomy_completed') : t('blog.admin.taxonomy_ongoing')}</Badge></td>}
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => edit(item)}>{t('blog.admin.taxonomy_edit')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => void remove(item)}>{t('blog.admin.taxonomy_delete')}</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form className="h-fit space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {editing ? t('blog.admin.taxonomy_edit') : t('blog.admin.taxonomy_add')}
        </h2>
        <Field label={t('blog.admin.taxonomy_name')}>
          <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={120} />
        </Field>
        <Field label={t('blog.admin.taxonomy_slug')} hint={t('blog.admin.taxonomy_slug_hint')}>
          <Input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} maxLength={120} />
        </Field>
        <Field label={t('blog.admin.taxonomy_description')}>
          <Textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={500} />
        </Field>
        {kind === 'tags' && (
          <Field label={t('blog.admin.taxonomy_color')} hint={t('blog.admin.taxonomy_color_hint')}>
            <Input value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} maxLength={20} />
          </Field>
        )}
        {kind === 'series' && (
          <Field label={t('blog.admin.taxonomy_status')}>
            <Select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              <option value="ongoing">{t('blog.admin.taxonomy_ongoing')}</option>
              <option value="completed">{t('blog.admin.taxonomy_completed')}</option>
            </Select>
          </Field>
        )}
        <div className="flex gap-2">
          <Button type="submit" loading={saving} disabled={!form.name.trim()}>{t('blog.admin.save')}</Button>
          {editing && <Button type="button" variant="ghost" onClick={() => setForm(EMPTY_FORM)}>{t('common.cancel')}</Button>}
        </div>
      </form>
      </section>
    </div>
  )
}
