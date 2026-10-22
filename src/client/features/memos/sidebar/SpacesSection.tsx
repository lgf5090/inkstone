import { useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { Folder, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoSpace } from '@shared/memos/types'
import { Button, IconButton, SectionLabel } from '../../../components/primitives'
import { Field, Input, Segmented, Textarea } from '../../../components/form'
import { Skeleton } from '../../../components/feedback'
import { Menu, Modal, Tooltip, type MenuItem } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { memosApi, type MemoSpaceDeleteMode } from '../api'
import { memoErrorMessage } from '../errors'
import { bump } from '../events'
import { navigateMemoUrl } from '../url-state'
import type { MemoResourceStatus } from '../use-resource'
import { SidebarLink } from './SidebarLink'

export const MEMO_SPACE_TITLE_MAX_LENGTH = 120
export const MEMO_SPACE_DESCRIPTION_MAX_LENGTH = 1024
export const MEMO_SPACE_ICON_MAX_LENGTH = 64

export interface SpacesSectionProps {
  spaces: MemoSpace[]
  status: MemoResourceStatus
  error: string | null
  activeSpaceId: string | null
  onRetry: () => void
  onNavigate: () => void
}

export function SpacesSection({
  spaces,
  status,
  error,
  activeSpaceId,
  onRetry,
  onNavigate,
}: SpacesSectionProps): ReactElement {
  const [editor, setEditor] = useState<{ space: MemoSpace | null } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MemoSpace | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const startDelete = (space: MemoSpace): void => {
    setDeleteError(null)
    setDeleteTarget(space)
  }

  return (
    <div className="pt-2">
      <div className="flex items-center gap-0.5 pr-1">
        <SectionLabel className="flex-1">{t('memos.nav.spaces')}</SectionLabel>
        <Tooltip label={t('memos.spaces.create')} side="left">
          <IconButton label={t('memos.spaces.create')} size="xs" onClick={() => setEditor({ space: null })}>
            <Plus size={12} />
          </IconButton>
        </Tooltip>
      </div>
      {status === 'loading' && spaces.length === 0 ? (
        <div className="space-y-1 px-2 py-1">
          <Skeleton className="h-6" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      ) : null}
      {status === 'error' && spaces.length === 0 ? (
        <div className="px-2 py-1">
          <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
            {error ?? t('memos.sidebar.spaces_error')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={onRetry}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {status === 'ready' && spaces.length === 0 ? (
        <div className="px-2 py-1">
          <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
            {t('memos.sidebar.spaces_empty')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={() => setEditor({ space: null })}>
            {t('memos.spaces.create')}
          </Button>
        </div>
      ) : null}
      {spaces.length > 0 ? (
        <ul className="space-y-0.5">
          {spaces.map((space) => (
            <SpaceRow
              key={space.id}
              space={space}
              active={space.id === activeSpaceId}
              onNavigate={onNavigate}
              onEdit={() => setEditor({ space })}
              onDelete={() => startDelete(space)}
            />
          ))}
        </ul>
      ) : null}
      {deleteError ? (
        <div role="alert" className="mx-2 mt-1 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2 py-1.5">
          <p className="text-[length:var(--text-11)] font-medium text-[var(--danger)]">
            {t('memos.spaces.delete_failed')}
          </p>
          <p className="mt-0.5 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-tertiary)]">
            {deleteError}
          </p>
        </div>
      ) : null}
      {editor ? (
        <SpaceEditor
          key={editor.space?.id ?? 'new'}
          space={editor.space}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteSpaceDialog
          key={deleteTarget.id}
          space={deleteTarget}
          active={deleteTarget.id === activeSpaceId}
          onClose={() => setDeleteTarget(null)}
          onFailed={(message) => {
            setDeleteTarget(null)
            setDeleteError(message)
          }}
        />
      ) : null}
    </div>
  )
}

interface DeleteSpaceDialogProps {
  space: MemoSpace
  active: boolean
  onClose: () => void
  onFailed: (message: string) => void
}

function DeleteSpaceDialog({ space, active, onClose, onFailed }: DeleteSpaceDialogProps): ReactElement {
  const hintId = useId()
  const [mode, setMode] = useState<MemoSpaceDeleteMode>('unfile')
  const [deleting, setDeleting] = useState(false)

  const remove = async (): Promise<void> => {
    if (deleting) return
    setDeleting(true)
    try {
      await memosApi.spaces.delete(space.id, mode)
      if (active) navigateMemoUrl(MEMOS_APP_PATH, '')
      bump('spaces')
      onClose()
    } catch (error) {
      onFailed(memoErrorMessage(error))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!deleting}
      title={t('memos.spaces.delete_title')}
      description={t('memos.spaces.delete_description', { title: space.title, count: space.memoCount })}
      width={480}
      footer={(
        <>
          <Button data-autofocus variant="ghost" disabled={deleting} onClick={onClose}>
            {t('memos.common.cancel')}
          </Button>
          <Button variant="danger" loading={deleting} onClick={() => void remove()}>
            {t('memos.spaces.delete_confirm')}
          </Button>
        </>
      )}
    >
      <div className="space-y-2">
        <Segmented
          value={mode}
          onChange={setMode}
          disabled={deleting}
          label={t('memos.spaces.delete_mode_label')}
          aria-describedby={hintId}
          options={[
            { value: 'unfile', label: t('memos.spaces.delete_mode_unfile') },
            { value: 'delete', label: t('memos.spaces.delete_mode_delete') },
          ]}
        />
        <p
          id={hintId}
          className={mode === 'delete'
            ? 'text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]'
            : 'text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]'}
        >
          {mode === 'delete'
            ? t('memos.spaces.delete_mode_delete_hint')
            : t('memos.spaces.delete_mode_unfile_hint')}
        </p>
      </div>
    </Modal>
  )
}

interface SpaceRowProps {
  space: MemoSpace
  active: boolean
  onNavigate: () => void
  onEdit: () => void
  onDelete: () => void
}

function SpaceRow({ space, active, onNavigate, onEdit, onDelete }: SpaceRowProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const path = `${MEMOS_APP_PATH}/spaces/${encodeURIComponent(space.id)}`
  const actionsLabel = t('memos.spaces.actions', { title: space.title })
  const items: MenuItem[] = [
    {
      id: 'edit',
      label: t('memos.spaces.edit'),
      icon: <Pencil size={13} />,
      onSelect: onEdit,
    },
    {
      id: 'delete',
      label: t('memos.spaces.delete'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: onDelete,
    },
  ]
  return (
    <li className="group flex items-center gap-0.5">
      <div className="min-w-0 flex-1">
        <SidebarLink
          href={path}
          active={active}
          icon={space.icon ? <span className="text-[length:var(--text-12)]">{space.icon}</span> : <Folder size={13} />}
          label={space.title}
          count={space.memoCount ?? null}
          onActivate={() => navigateMemoUrl(path, '')}
          onNavigate={onNavigate}
        />
      </div>
      <Tooltip label={actionsLabel} side="left">
        <IconButton
          ref={triggerRef}
          label={actionsLabel}
          size="sm"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
          className="shrink-0 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
        >
          <MoreHorizontal size={13} />
        </IconButton>
      </Tooltip>
      <Menu
        anchor={triggerRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={items}
        label={actionsLabel}
        align="end"
        width={180}
      />
    </li>
  )
}

interface SpaceEditorProps {
  space: MemoSpace | null
  onClose: () => void
}

function SpaceEditor({ space, onClose }: SpaceEditorProps): ReactElement {
  const formId = useId()
  const [title, setTitle] = useState(space?.title ?? '')
  const [description, setDescription] = useState(space?.description ?? '')
  const [icon, setIcon] = useState(space?.icon ?? '')
  const [saving, setSaving] = useState(false)
  const [titleError, setTitleError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setTitleError(t('memos.spaces.title_required'))
      return
    }
    if (trimmedTitle.length > MEMO_SPACE_TITLE_MAX_LENGTH) {
      setTitleError(t('memos.spaces.title_too_long'))
      return
    }
    setTitleError(null)
    setSaving(true)
    setFailure(null)
    const input = {
      title: trimmedTitle,
      description: description.trim(),
      icon: icon.trim(),
    }
    try {
      if (space) await memosApi.spaces.update(space.id, input)
      else await memosApi.spaces.create(input)
      bump('spaces')
      onClose()
    } catch (error) {
      setFailure(memoErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!saving}
      title={space ? t('memos.spaces.edit_title') : t('memos.spaces.create_title')}
      description={t('memos.spaces.form_hint')}
      width={480}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>{t('memos.common.cancel')}</Button>
          <Button type="submit" form={formId} variant="primary" loading={saving}>
            {saving ? t('memos.spaces.saving') : t('memos.common.save')}
          </Button>
        </>
      )}
    >
      <form id={formId} onSubmit={(event) => void submit(event)} className="space-y-3">
        {failure ? (
          <div role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
            <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
              {t('memos.spaces.save_failed')}
            </p>
            <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
              {failure}
            </p>
          </div>
        ) : null}
        <Field
          label={t('memos.spaces.title_label')}
          required
          hint={titleError ? <span role="alert" className="text-[var(--danger)]">{titleError}</span> : undefined}
        >
          <Input
            data-autofocus
            value={title}
            maxLength={MEMO_SPACE_TITLE_MAX_LENGTH}
            invalid={Boolean(titleError)}
            onChange={(event) => {
              setTitle(event.target.value)
              if (titleError) setTitleError(null)
            }}
          />
        </Field>
        <Field label={t('memos.spaces.icon_label')} hint={t('memos.spaces.icon_hint')}>
          <Input
            value={icon}
            maxLength={MEMO_SPACE_ICON_MAX_LENGTH}
            onChange={(event) => setIcon(event.target.value)}
          />
        </Field>
        <Field label={t('memos.spaces.description_label')}>
          <Textarea
            value={description}
            rows={3}
            maxLength={MEMO_SPACE_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  )
}
