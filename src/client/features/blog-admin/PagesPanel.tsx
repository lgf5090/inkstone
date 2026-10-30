import { useCallback, useEffect, useState } from 'react'
import type { BlogPageItem } from '@shared/blog/model'
import { Badge, Button, Spinner } from '../../components/primitives'
import { Checkbox, Field, Input, Select, Textarea } from '../../components/form'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'

interface PageForm {
  id: string | null
  title: string
  slug: string
  kind: string
  body: string
  publish: boolean
}

const EMPTY: PageForm = { id: null, title: '', slug: '', kind: 'custom', body: '', publish: false }

function formatDate(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
  } catch {
    return new Date(value).toISOString().slice(0, 10)
  }
}

export function PagesPanel() {
  const [items, setItems] = useState<BlogPageItem[]>([])
  const [form, setForm] = useState<PageForm>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setItems((await api.blog.pages.list()).items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const edit = (page: BlogPageItem) => {
    setForm({
      id: page.id,
      title: page.title,
      slug: page.slug,
      kind: page.kind,
      body: page.body,
      publish: page.publishedAt !== null,
    })
  }

  const save = async () => {
    if (!form.title.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      const input = { title: form.title, slug: form.slug || undefined, kind: form.kind, body: form.body, publish: form.publish }
      if (form.id) await api.blog.pages.update(form.id, input)
      else await api.blog.pages.create(input)
      setForm(EMPTY)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (page: BlogPageItem) => {
    const ok = await confirm({
      title: t('blog.admin.page_delete_title'),
      description: t('blog.admin.page_delete_desc'),
      confirmLabel: t('blog.admin.page_delete'),
      tone: 'danger',
    })
    if (!ok) return
    setError('')
    try {
      await api.blog.pages.remove(page.id)
      if (form.id === page.id) setForm(EMPTY)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-4">
        {error && <p role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        {loading && items.length === 0 ? (
          <div className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner /> {t('blog.admin.loading')}</div>
        ) : items.length === 0 ? (
          <p className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('blog.admin.page_empty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <table className="w-full min-w-[620px] border-collapse text-left text-[length:var(--text-12-5)]">
              <caption className="sr-only">{t('blog.admin.pages')}</caption>
              <thead className="border-b border-[var(--border-subtle)] text-[length:var(--text-11)] tracking-wide text-[var(--text-tertiary)] uppercase">
                <tr>
                  <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.page_title')}</th>
                  <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.page_kind')}</th>
                  <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.column_status')}</th>
                  <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.column_updated')}</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">{t('blog.admin.column_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((page) => (
                  <tr key={page.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
                    <td className="px-3 py-3">
                      <p className="font-medium text-[var(--text-primary)]">{page.title}</p>
                      <p className="mt-0.5 font-mono text-[length:var(--text-11)] text-[var(--text-quaternary)]">/{page.slug}</p>
                    </td>
                    <td className="px-3 py-3 text-[var(--text-secondary)]">{page.kind === 'about' ? t('blog.admin.page_about') : t('blog.admin.page_custom')}</td>
                    <td className="px-3 py-3"><Badge tone={page.publishedAt ? 'success' : 'neutral'}>{page.publishedAt ? t('blog.admin.page_published') : t('blog.admin.page_draft')}</Badge></td>
                    <td className="px-3 py-3 text-[var(--text-tertiary)]">{formatDate(page.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => edit(page)}>{t('blog.admin.page_edit')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => void remove(page)}>{t('blog.admin.page_delete')}</Button>
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
          {form.id ? t('blog.admin.page_edit') : t('blog.admin.page_new')}
        </h2>
        <Field label={t('blog.admin.page_title')}><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={200} /></Field>
        <Field label={t('blog.admin.page_slug')}><Input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} maxLength={120} /></Field>
        <Field label={t('blog.admin.page_kind')}>
          <Select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            <option value="custom">{t('blog.admin.page_custom')}</option>
            <option value="about">{t('blog.admin.page_about')}</option>
          </Select>
        </Field>
        <Field label={t('blog.admin.page_body')}>
          <Textarea rows={14} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} className="font-mono" />
        </Field>
        <Checkbox checked={form.publish} onChange={(publish) => setForm({ ...form, publish })} label={t('blog.admin.page_publish')} />
        <div className="flex gap-2">
          <Button type="submit" loading={saving} disabled={!form.title.trim()}>{t('blog.admin.save')}</Button>
          {form.id && <Button type="button" variant="ghost" onClick={() => setForm(EMPTY)}>{t('common.cancel')}</Button>}
        </div>
      </form>
    </section>
  )
}
