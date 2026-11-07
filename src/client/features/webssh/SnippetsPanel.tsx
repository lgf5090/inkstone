// The snippet library (plan W7-02). It is a dialog rather than a docked pane so the host list and
// the terminal can both open it; `onInsert` is present only when a terminal tab is active, and the
// insert control says why it is disabled instead of silently doing nothing.

import { useEffect, useState } from 'react'
import { Pencil, Plus, Search, Star, Trash2, TerminalSquare } from 'lucide-react'
import type { WebsshSnippet } from '@shared/webssh/types'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Field, Input, Switch, Textarea } from '../../components/form'
import { Empty } from '../../components/feedback'
import { Modal, Tooltip, confirm } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { websshApi } from './api'

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : t('webssh.error.generic')
}

interface SnippetDraft {
  title: string
  command: string
  description: string
  tags: string
  shell: string
  favorite: boolean
}

const EMPTY_DRAFT: SnippetDraft = { title: '', command: '', description: '', tags: '', shell: '', favorite: false }

function draftFor(snippet: WebsshSnippet): SnippetDraft {
  return {
    title: snippet.title,
    command: snippet.command,
    description: snippet.description,
    tags: snippet.tags.join(', '),
    shell: snippet.shell,
    favorite: snippet.favorite,
  }
}

export function SnippetsPanel({ open, onClose, onInsert }: {
  open: boolean
  onClose: () => void
  onInsert?: (command: string) => void
}) {
  const [items, setItems] = useState<WebsshSnippet[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [editing, setEditing] = useState<WebsshSnippet | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<SnippetDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput)
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [queryInput])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    websshApi.listSnippets({ q: query, favorite: favoriteOnly, page, pageSize })
      .then((response) => {
        if (cancelled) return
        setItems(response.items)
        setTotal(response.total)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, query, favoriteOnly, page, pageSize, reloadToken])

  const refresh = () => setReloadToken((value) => value + 1)

  const openCreate = () => {
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setEditorError(null)
    setEditorOpen(true)
  }

  const openEdit = (snippet: WebsshSnippet) => {
    setEditing(snippet)
    setDraft(draftFor(snippet))
    setEditorError(null)
    setEditorOpen(true)
  }

  const save = async () => {
    const title = draft.title.trim()
    const command = draft.command.trim()
    if (!title || !command) return
    setSaving(true)
    setEditorError(null)
    try {
      const tags = draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
      const body = {
        title,
        command: draft.command,
        description: draft.description,
        tags,
        shell: draft.shell.trim(),
        favorite: draft.favorite,
      }
      if (editing) await websshApi.updateSnippet(editing.id, body)
      else await websshApi.createSnippet(body)
      useUi.getState().toast({ title: t('webssh.snippet.saved'), tone: 'success' })
      setEditorOpen(false)
      refresh()
    } catch (caught) {
      setEditorError(errorText(caught))
    } finally {
      setSaving(false)
    }
  }

  const toggleFavorite = async (snippet: WebsshSnippet) => {
    try {
      await websshApi.updateSnippet(snippet.id, { favorite: !snippet.favorite })
      refresh()
    } catch (caught) {
      useUi.getState().toast({ title: errorText(caught), tone: 'danger' })
    }
  }

  const remove = async (snippet: WebsshSnippet) => {
    const approved = await confirm({
      title: t('webssh.snippet.remove_title'),
      description: t('webssh.snippet.remove_description', { title: snippet.title }),
      tone: 'danger',
      confirmLabel: t('webssh.actions.delete'),
    })
    if (!approved) return
    try {
      await websshApi.deleteSnippet(snippet.id)
      refresh()
    } catch (caught) {
      useUi.getState().toast({ title: errorText(caught), tone: 'danger' })
    }
  }

  const insert = async (snippet: WebsshSnippet) => {
    if (!onInsert) return
    onInsert(snippet.command)
    useUi.getState().toast({ title: t('webssh.snippet.inserted'), tone: 'success' })
    try {
      await websshApi.touchSnippet(snippet.id)
    } catch {
      // Usage history is informational; a failed touch must not hide a successful insert.
    }
    onClose()
  }

  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('webssh.snippet.title')}
        description={t('webssh.snippet.description')}
        width={760}
        footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder={t('webssh.snippet.search_placeholder')}
              aria-label={t('webssh.snippet.search_placeholder')}
              leading={<Search size={14} aria-hidden="true" />}
              className="min-w-0 flex-1"
            />
            <Button
              size="sm"
              variant={favoriteOnly ? 'primary' : 'secondary'}
              aria-pressed={favoriteOnly}
              icon={<Star size={13} aria-hidden="true" />}
              onClick={() => {
                setFavoriteOnly((value) => !value)
                setPage(1)
              }}
            >
              {t('webssh.snippet.favorites')}
            </Button>
            <Button size="sm" variant="primary" icon={<Plus size={13} aria-hidden="true" />} onClick={openCreate}>
              {t('webssh.snippet.new')}
            </Button>
          </div>

          {!onInsert && (
            <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.snippet.insert_unavailable')}</p>
          )}
          {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}

          {loading && items.length === 0 ? (
            <div className="flex justify-center py-8"><Spinner size={16} /></div>
          ) : items.length === 0 ? (
            <Empty
              art={query || favoriteOnly ? 'search' : 'select'}
              compact
              title={query || favoriteOnly ? t('webssh.snippet.no_results') : t('webssh.snippet.empty')}
            />
          ) : (
            <div className="overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] uppercase tracking-wide text-[var(--text-quaternary)]">
                    <th className="px-9 py-1.5 font-medium">{t('webssh.snippet.title_label')}</th>
                    <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t('webssh.snippet.tags')}</th>
                    <th className="px-2 py-1.5 font-medium text-end">{t('webssh.snippet.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {items.map((snippet) => (
                    <tr key={snippet.id} className="align-top hover:bg-[var(--bg-hover)]">
                      <td className="px-2 py-2">
                        <div className="flex items-start gap-1">
                          <IconButton
                            label={snippet.favorite ? t('webssh.snippet.unfavorite') : t('webssh.snippet.favorite')}
                            size="xs"
                            active={snippet.favorite}
                            onClick={() => void toggleFavorite(snippet)}
                          >
                            <Star size={13} aria-hidden="true" />
                          </IconButton>
                          <div className="min-w-0">
                            <p className="truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{snippet.title}</p>
                            <p className="mt-0.5 line-clamp-2 break-all font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">{snippet.command}</p>
                            <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                              {snippet.lastUsedAt
                                ? t('webssh.snippet.last_used', { date: new Date(snippet.lastUsedAt).toLocaleString() })
                                : t('webssh.snippet.never_used')}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-2 py-2 sm:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {snippet.tags.map((tag) => (
                            <span key={tag} className="rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-0.5">
                          {onInsert && (
                            <Tooltip label={t('webssh.snippet.insert')}>
                              <IconButton label={t('webssh.snippet.insert')} size="xs" onClick={() => void insert(snippet)}>
                                <TerminalSquare size={13} aria-hidden="true" />
                              </IconButton>
                            </Tooltip>
                          )}
                          <Tooltip label={t('webssh.actions.edit')}>
                            <IconButton label={t('webssh.actions.edit')} size="xs" onClick={() => openEdit(snippet)}>
                              <Pencil size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip label={t('webssh.actions.delete')}>
                            <IconButton label={t('webssh.actions.delete')} size="xs" onClick={() => void remove(snippet)}>
                              <Trash2 size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <span>{t('webssh.snippet.count', { count: total })}</span>
            <span className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                {t('webssh.actions.previous')}
              </Button>
              <span>{t('webssh.snippet.page', { page, pages })}</span>
              <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
                {t('webssh.actions.next')}
              </Button>
            </span>
          </div>
        </div>
      </Modal>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing ? t('webssh.snippet.edit_title') : t('webssh.snippet.create_title')}
        width={520}
        dismissible={!saving}
        footer={
          <>
            <Button onClick={() => setEditorOpen(false)}>{t('webssh.actions.cancel')}</Button>
            <Button variant="primary" loading={saving} disabled={!draft.title.trim() || !draft.command.trim()} onClick={() => void save()}>
              {t('webssh.actions.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('webssh.snippet.title_label')} required>
            <Input value={draft.title} maxLength={120} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </Field>
          <Field label={t('webssh.snippet.command')} required>
            <Textarea rows={3} value={draft.command} className="font-mono" onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
          </Field>
          <Field label={t('webssh.snippet.description_label')}>
            <Input value={draft.description} maxLength={1000} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </Field>
          <Field label={t('webssh.snippet.tags')} hint={t('webssh.snippet.tags_hint')}>
            <Input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
          </Field>
          <Field label={t('webssh.snippet.shell')}>
            <Input value={draft.shell} maxLength={64} onChange={(event) => setDraft({ ...draft, shell: event.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
            <Switch checked={draft.favorite} onChange={(checked) => setDraft({ ...draft, favorite: checked })} />
            {t('webssh.snippet.favorite')}
          </label>
          {editorError && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{editorError}</p>}
        </div>
      </Modal>
    </>
  )
}
