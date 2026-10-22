import { useId, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { ListFilter, Pencil, Plus, Trash2 } from 'lucide-react'
import type { MemoView } from '@shared/memos/types'
import { Button, IconButton } from '../../../components/primitives'
import { Empty, Skeleton } from '../../../components/feedback'
import { Field, Input, Textarea } from '../../../components/form'
import { Modal, confirm } from '../../../components/overlay'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { memosApi } from '../api'
import { memoErrorMessage } from '../errors'
import { bump, useRevision } from '../events'
import { useMemoResource } from '../use-resource'

export const MEMO_VIEW_TITLE_MAX_LENGTH = 120
export const MEMO_VIEW_ICON_MAX_LENGTH = 64

interface FilterExampleGroup {
  key: MessageKey
  examples: readonly string[]
}

const FILTER_EXAMPLE_GROUPS: readonly FilterExampleGroup[] = [
  {
    key: 'memos.views.example_group_state',
    examples: ['pinned', 'pinned == false'],
  },
  {
    key: 'memos.views.example_group_time',
    examples: [
      'created_ts >= now - duration("1h")',
      'created_ts.getFullYear() == 2024',
      'created_ts.getDayOfWeek() == 0 || created_ts.getDayOfWeek() == 6',
    ],
  },
  {
    key: 'memos.views.example_group_visibility',
    examples: ['visibility == "PUBLIC"', 'visibility in ["PUBLIC", "PROTECTED"]'],
  },
  {
    key: 'memos.views.example_group_tags',
    examples: [
      'tag in ["work", "personal"]',
      '"work" in tags',
      'size(tags) == 0',
      'tags.exists(t, t.startsWith("project/"))',
      'tags.all(t, t.endsWith("-done"))',
      'sets.contains(tags, ["work", "urgent"])',
      'sets.equivalent(tags, ["inbox"])',
    ],
  },
  {
    key: 'memos.views.example_group_properties',
    examples: ['has_task_list && has_incomplete_tasks', 'has_link || has_code', '!has_location'],
  },
  {
    key: 'memos.views.example_group_content',
    examples: [
      'content.contains("TODO")',
      'content.startsWith("TODO")',
      'content.matches("v[0-9]+")',
      'size(content) > 280',
    ],
  },
]

type ValidationState =
  | { kind: 'idle' }
  | { kind: 'valid' }
  | { kind: 'error'; message: string; position: number | null }

function caretPreview(expression: string, position: number | null): string {
  if (position === null) return expression
  const column = Math.max(0, Math.min(position, expression.length))
  const before = expression.slice(0, column)
  const lineStart = before.lastIndexOf('\n') + 1
  const lineEnd = expression.indexOf('\n', lineStart)
  const line = expression.slice(lineStart, lineEnd < 0 ? expression.length : lineEnd)
  return `${line}\n${' '.repeat(column - lineStart)}^`
}

export function MemoViewsPage(): ReactElement {
  const revision = useRevision('views')
  const views = useMemoResource(
    (signal) => memosApi.views.list(signal).then((page) => page.views),
    [revision],
  )
  const [editor, setEditor] = useState<{ view: MemoView | null; filter: string } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const listId = useId()
  const items = useMemo(() => views.data ?? [], [views.data])
  const loading = views.status === 'loading' && views.data === null
  const failed = views.status === 'error' && views.data === null
  const empty = views.data !== null && items.length === 0

  const removeView = async (view: MemoView): Promise<void> => {
    setDeleteError(null)
    const agreed = await confirm({
      title: t('memos.views.delete_title'),
      description: t('memos.views.delete_description', { title: view.title }),
      confirmLabel: t('memos.common.delete'),
      cancelLabel: t('memos.common.cancel'),
      tone: 'danger',
    })
    if (!agreed) return
    try {
      await memosApi.views.delete(view.id)
      bump('views')
    } catch (error) {
      setDeleteError(memoErrorMessage(error))
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-memos-views="">
      <div className="mx-auto w-full max-w-[var(--memo-library-width)] px-3 py-3 md:px-5 md:py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
              {t('memos.views.page_title')}
            </h2>
            <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
              {t('memos.views.page_description')}
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            icon={<Plus size={13} />}
            onClick={() => setEditor({ view: null, filter: '' })}
          >
            {t('memos.views.new')}
          </Button>
        </div>
        {deleteError ? (
          <div role="alert" className="mt-3 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
            <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
              {t('memos.views.delete_failed')}
            </p>
            <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
              {deleteError}
            </p>
          </div>
        ) : null}
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby={listId} className="min-w-0">
            <h3 id={listId} className="sr-only">{t('memos.views.list_label')}</h3>
            {loading ? (
              <>
                <p role="status" aria-live="polite" className="sr-only">{t('memos.common.loading')}</p>
                <div className="space-y-2" aria-hidden="true">
                  <Skeleton className="h-16 rounded-[var(--r-lg)]" />
                  <Skeleton className="h-16 rounded-[var(--r-lg)]" />
                  <Skeleton className="h-16 rounded-[var(--r-lg)]" />
                </div>
              </>
            ) : null}
            {failed ? (
              <Empty
                art="folder"
                title={t('memos.views.error_title')}
                description={views.error ?? t('memos.views.error_description')}
                action={(
                  <Button size="sm" onClick={views.reload}>
                    {t('memos.common.retry')}
                  </Button>
                )}
              />
            ) : null}
            {empty ? (
              <Empty
                art="folder"
                title={t('memos.views.empty_title')}
                description={t('memos.views.empty_description')}
                action={(
                  <Button size="sm" onClick={() => setEditor({ view: null, filter: '' })}>
                    {t('memos.views.new')}
                  </Button>
                )}
              />
            ) : null}
            {items.length > 0 ? (
              <ul className="space-y-2">
                {items.map((view) => (
                  <ViewRow
                    key={view.id}
                    view={view}
                    onEdit={() => setEditor({ view, filter: view.filter })}
                    onDelete={() => void removeView(view)}
                  />
                ))}
              </ul>
            ) : null}
          </section>
          <ViewHelp onPick={(filter) => setEditor({ view: null, filter })} />
        </div>
      </div>
      {editor ? (
        <ViewEditor
          key={editor.view?.id ?? 'new'}
          view={editor.view}
          initialFilter={editor.filter}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  )
}

interface ViewRowProps {
  view: MemoView
  onEdit: () => void
  onDelete: () => void
}

function ViewRow({ view, onEdit, onDelete }: ViewRowProps): ReactElement {
  return (
    <li className="flex flex-wrap items-start gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
        {view.icon || <ListFilter size={14} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{view.title}</p>
        <code className="mt-1 block whitespace-pre-wrap break-words font-mono text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
          {view.filter}
        </code>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label={t('memos.views.edit_named', { title: view.title })}
          size="sm"
          onClick={onEdit}
        >
          <Pencil size={13} />
        </IconButton>
        <IconButton
          label={t('memos.views.delete_named', { title: view.title })}
          size="sm"
          onClick={onDelete}
        >
          <Trash2 size={13} />
        </IconButton>
      </div>
    </li>
  )
}

function ViewHelp({ onPick }: { onPick: (filter: string) => void }): ReactElement {
  return (
    <aside className="min-w-0">
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <h3 className="text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
          {t('memos.views.examples_title')}
        </h3>
        <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
          {t('memos.views.examples_description')}
        </p>
        <div className="mt-2.5 space-y-3">
          {FILTER_EXAMPLE_GROUPS.map((group) => (
            <div key={group.key}>
              <p className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[0.06em] text-[var(--text-quaternary)]">
                {t(group.key)}
              </p>
              <ul className="mt-1 space-y-1">
                {group.examples.map((expression) => (
                  <li key={expression}>
                    <button
                      type="button"
                      data-memo-view-example={expression}
                      onClick={() => onPick(expression)}
                      className={cn(
                        'block w-full rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1 text-left',
                        'font-mono text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-secondary)]',
                        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                        'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                      )}
                    >
                      {expression}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <details className="mt-3 border-t border-[var(--border-subtle)] pt-2">
          <summary className="cursor-pointer text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">
            {t('memos.views.fields_title')}
          </summary>
          <p className="mt-1.5 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">
            {t('memos.views.fields_description')}
          </p>
          <p className="mt-1.5 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">
            {t('memos.views.functions_description')}
          </p>
        </details>
      </div>
    </aside>
  )
}

interface ViewEditorProps {
  view: MemoView | null
  initialFilter: string
  onClose: () => void
}

function ViewEditor({ view, initialFilter, onClose }: ViewEditorProps): ReactElement {
  const formId = useId()
  const errorId = useId()
  const [title, setTitle] = useState(view?.title ?? '')
  const [icon, setIcon] = useState(view?.icon ?? '')
  const [filter, setFilter] = useState(view?.filter ?? initialFilter)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [titleError, setTitleError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [checkFailure, setCheckFailure] = useState<string | null>(null)
  const [validation, setValidation] = useState<ValidationState>({ kind: 'idle' })

  const runValidation = async (): Promise<boolean> => {
    const expression = filter.trim()
    if (!expression) {
      setValidation({ kind: 'error', message: t('memos.views.filter_required'), position: null })
      return false
    }
    setChecking(true)
    setCheckFailure(null)
    setFailure(null)
    try {
      const result = await memosApi.views.validate(expression)
      if (result.ok) {
        setValidation({ kind: 'valid' })
        return true
      }
      setValidation({
        kind: 'error',
        message: result.error?.message ?? t('memos.views.filter_invalid'),
        position: result.error?.position ?? null,
      })
      return false
    } catch (error) {
      setCheckFailure(memoErrorMessage(error))
      setValidation({ kind: 'idle' })
      return false
    } finally {
      setChecking(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving || checking) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setTitleError(t('memos.views.title_required'))
      return
    }
    if (trimmedTitle.length > MEMO_VIEW_TITLE_MAX_LENGTH) {
      setTitleError(t('memos.views.title_too_long'))
      return
    }
    setTitleError(null)
    setSaving(true)
    setFailure(null)
    try {
      if (!(await runValidation())) return
      const input = {
        title: trimmedTitle,
        filter: filter.trim(),
        icon: icon.trim(),
      }
      if (view) await memosApi.views.update(view.id, input)
      else await memosApi.views.create(input)
      bump('views')
      onClose()
    } catch (error) {
      setFailure(memoErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const showError = validation.kind === 'error'
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!saving}
      title={view ? t('memos.views.edit_title') : t('memos.views.create_title')}
      description={t('memos.views.form_hint')}
      width={560}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>{t('memos.common.cancel')}</Button>
          <Button type="submit" form={formId} variant="primary" loading={saving}>
            {saving ? t('memos.views.saving') : t('memos.common.save')}
          </Button>
        </>
      )}
    >
      <form id={formId} onSubmit={(event) => void submit(event)} className="space-y-3">
        {failure ? (
          <div role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
            <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
              {t('memos.views.save_failed')}
            </p>
            <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
              {failure}
            </p>
          </div>
        ) : null}
        <Field
          label={t('memos.views.title_label')}
          required
          hint={titleError ? <span role="alert" className="text-[var(--danger)]">{titleError}</span> : undefined}
        >
          <Input
            data-autofocus
            value={title}
            maxLength={MEMO_VIEW_TITLE_MAX_LENGTH}
            invalid={Boolean(titleError)}
            onChange={(event) => {
              setTitle(event.target.value)
              if (titleError) setTitleError(null)
            }}
          />
        </Field>
        <Field label={t('memos.views.icon_label')} hint={t('memos.views.icon_hint')}>
          <Input
            value={icon}
            maxLength={MEMO_VIEW_ICON_MAX_LENGTH}
            onChange={(event) => setIcon(event.target.value)}
          />
        </Field>
        <Field label={t('memos.views.filter_label')} hint={t('memos.views.filter_hint')}>
          <Textarea
            value={filter}
            rows={4}
            aria-invalid={showError ? true : undefined}
            aria-describedby={showError ? errorId : undefined}
            onChange={(event) => {
              setFilter(event.target.value)
              setValidation({ kind: 'idle' })
              setCheckFailure(null)
            }}
            className="font-mono text-[length:var(--text-12)]"
          />
        </Field>
        <div className="flex flex-wrap items-start gap-2">
          <Button size="sm" variant="secondary" loading={checking} disabled={saving} onClick={() => void runValidation()}>
            {checking ? t('memos.views.checking') : t('memos.views.check')}
          </Button>
          {validation.kind === 'valid' ? (
            <p role="status" className="pt-1 text-[length:var(--text-11)] text-[var(--success)]">
              {t('memos.views.filter_valid')}
            </p>
          ) : null}
        </div>
        {checkFailure ? (
          <div role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
            <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
              {t('memos.views.check_failed')}
            </p>
            <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
              {checkFailure}
            </p>
          </div>
        ) : null}
        {showError ? (
          <div id={errorId} role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
            <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
              {t('memos.views.validation_error', { message: validation.message })}
            </p>
            {validation.position !== null ? (
              <>
                <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                  {t('memos.views.validation_position', { position: validation.position + 1 })}
                </p>
                <pre aria-hidden="true" className="mt-1 overflow-x-auto font-mono text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-secondary)]">
                  {caretPreview(filter, validation.position)}
                </pre>
              </>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  )
}
