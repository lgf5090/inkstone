/**
 * The owner's published directories: what is public, under what access, and how much is in each one.
 *
 * A real table, because the question is a comparison across rows. Three facts about the server shape the
 * columns, and none of them is negotiable in the UI:
 *
 * - a folder or tag collection's members are derived on every read, so `count` is a number taken now and
 *   a page that is empty because every link inside it was paused is a correct page, not a broken one;
 * - only one enabled collection may exist per target, so resuming a paused directory can be refused with a
 *   409 — the refusal is reported and the list re-read, because the row that collided is not this row;
 * - the address is a capability. It is shown, copied, and offered again marked with this directory's own
 *   channel token; it is never put in a query string this app sends, and a preview of it goes through the
 *   unauthenticated endpoint so the owner sees what a stranger sees, including a passcode refusal.
 */
import { ExternalLink, Eye, KeyRound, MoreHorizontal, PauseCircle, PlayCircle, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublicCollection, ShareCollection, ShareFolder, ShareTag } from '@shared/share-hub'
import { collectionChannelToken, withChannelParam } from '@shared/share-channel'
import type { ShareListItem } from '@shared/types'
import { Badge, Button, IconButton, Spinner } from '../../../components/primitives'
import { LoadingBlock } from '../../../components/feedback'
import { Menu, Modal, confirm, prompt, Tooltip } from '../../../components/overlay'
import type { MenuItem } from '../../../components/overlay'
import { Input } from '../../../components/form'
import { copyText } from '../../../lib/clipboard'
import { ApiError } from '../../../lib/api'
import { shareHubApi } from '../../../lib/api-share-hub'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { fullTime } from '../../../lib/time'
import { CollectionEditorDialog } from './collection-editor'

/** The public address of one directory, on whatever origin the hub is being read from. */
function directoryUrl(slug: string): string {
  return `${window.location.origin}/c/${encodeURIComponent(slug)}`
}

export function ShareCollectionsPanel({ onPreview }: { onPreview: (slug: string) => void }) {
  const toast = useUi((s) => s.toast)
  const [collections, setCollections] = useState<ShareCollection[] | null>(null)
  const [picker, setPicker] = useState<{ folders: ShareFolder[], tags: ShareTag[], shares: ShareListItem[] } | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ initial: ShareCollection | null } | null>(null)
  const [previewSlug, setPreviewSlug] = useState<string | null>(null)

  const reload = useCallback(() => setAttempt((count) => count + 1), [])

  /** The list alone, after a write: a pause, a rename and a revoke all change what the rows say. */
  const refreshCollections = useCallback(async () => {
    const page = await shareHubApi.collections.list()
    setCollections(page.collections)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setError(false)
    void Promise.all([
      shareHubApi.collections.list(controller.signal),
      shareHubApi.folders.list(controller.signal),
      shareHubApi.tags.list(controller.signal),
      shareHubApi.list(controller.signal),
    ])
      .then(([collectionPage, folderPage, tagPage, sharePage]) => {
        setCollections(collectionPage.collections)
        setPicker({ folders: folderPage.folders, tags: tagPage.tags, shares: sharePage.shares })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setError(true)
      })
    return () => controller.abort()
  }, [attempt])

  const runFor = async (collection: ShareCollection, action: () => Promise<unknown>, failedTitle: string) => {
    setBusyId(collection.id)
    try {
      await action()
      await refreshCollections()
    } catch (cause) {
      // A 409 here is the one-enabled-per-target rule answering a write that raced another one, and the
      // rows it collided with are not the rows on screen — so the panel re-reads rather than guessing.
      toast({
        title: failedTitle,
        description: cause instanceof Error ? cause.message : undefined,
        tone: 'danger',
      })
      await refreshCollections().catch(() => setError(true))
    } finally {
      setBusyId(null)
    }
  }

  const setEnabled = (collection: ShareCollection, isEnabled: boolean) => void runFor(
    collection,
    () => shareHubApi.collections.patch(collection.id, { isEnabled }),
    t('share.collection_action_failed'),
  )

  const rename = async (collection: ShareCollection) => {
    const next = await prompt({
      title: t('share.collection_rename_title'),
      description: t('share.collection_rename_hint'),
      defaultValue: collection.targetType === 'manual' ? collection.title : '',
      confirmLabel: t('common.save'),
    })
    if (!next) return
    await runFor(collection, () => shareHubApi.collections.patch(collection.id, { title: next }), t('share.collection_action_failed'))
  }

  /**
   * Revoking a directory, which takes the page and nothing else.
   *
   * The confirmation says so outright, because "revoke" reads like it goes for the links too — and the one
   * thing an owner cannot undo here is the address a directory was shared under.
   */
  const remove = async (collection: ShareCollection) => {
    const ok = await confirm({
      title: t('share.collection_delete_confirm_title', { title: collection.title }),
      description: t('share.collection_delete_confirm_desc'),
      confirmLabel: t('share.collection_delete_confirm_action'),
      tone: 'danger',
    })
    if (!ok) return
    await runFor(collection, () => shareHubApi.collections.remove(collection.id), t('share.collection_action_failed'))
  }

  const copy = async (url: string, doneTitle: string) => {
    // A capability, so it goes to the clipboard and nowhere else: not a log line, not a request this app
    // makes, not a query string of our own.
    const copied = await copyText(url)
    toast({
      title: copied ? doneTitle : t('share.collection_copy_failed'),
      tone: copied ? 'success' : 'danger',
    })
  }

  if (error && collections === null) {
    return (
      <div className="flex flex-col items-start gap-[var(--sp-2)] p-[var(--sp-4)]">
        <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{t('share.collection_load_failed')}</p>
        <Button size="sm" variant="secondary" onClick={reload}>{t('common.retry')}</Button>
      </div>
    )
  }
  if (collections === null) {
    return (
      <div className="flex flex-col gap-[var(--sp-2)] p-[var(--sp-4)]" aria-busy="true">
        <LoadingBlock label={t('common.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <header className="flex flex-wrap items-start justify-between gap-[var(--sp-2)]">
        <div className="min-w-0">
          <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('share.collection_panel_title')}
          </h3>
          <p className="mt-[var(--sp-1)] max-w-prose text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
            {t('share.collection_panel_hint')}
          </p>
        </div>
        <div className="flex items-center gap-[var(--sp-1)]">
          <Tooltip label={t('common.refresh')}>
            <IconButton label={t('common.refresh')} size="sm" onClick={reload}>
              <RefreshCw size={13} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Button size="sm" variant="primary" icon={<Plus size={12} aria-hidden="true" />} onClick={() => setEditor({ initial: null })}>
            {t('share.collection_publish_action')}
          </Button>
        </div>
      </header>

      {collections.length === 0
        ? <CollectionsEmpty onPublish={() => setEditor({ initial: null })} />
        : (
          <div className="overflow-x-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-2)]">
            <CollectionsTable
              collections={collections}
              busyId={busyId}
              onToggle={setEnabled}
              onRename={(collection) => void rename(collection)}
              onDelete={(collection) => void remove(collection)}
              onCopy={(url, doneTitle) => void copy(url, doneTitle)}
              onEdit={(collection) => setEditor({ initial: collection })}
              onPreview={setPreviewSlug}
              onOpen={onPreview}
            />
          </div>
        )}

      {editor && picker && (
        <CollectionEditorDialog
          folders={picker.folders}
          tags={picker.tags}
          shares={picker.shares}
          initial={editor.initial}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            reload()
          }}
        />
      )}
      {previewSlug && (
        <CollectionPreviewDialog slug={previewSlug} onClose={() => setPreviewSlug(null)} onOpen={onPreview} />
      )}
    </div>
  )
}

function CollectionsEmpty({ onPublish }: { onPublish: () => void }) {
  return (
    <div className="flex flex-col items-center gap-[var(--sp-2)] py-[var(--sp-8)] text-center">
      <p className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">{t('share.collection_empty')}</p>
      <p className="max-w-prose text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
        {t('share.collection_empty_hint')}
      </p>
      <Button size="sm" variant="secondary" onClick={onPublish}>{t('share.collection_publish_action')}</Button>
    </div>
  )
}

function CollectionsTable({ collections, busyId, onToggle, onRename, onDelete, onCopy, onEdit, onPreview, onOpen }: {
  collections: ShareCollection[]
  busyId: string | null
  onToggle: (collection: ShareCollection, enabled: boolean) => void
  onRename: (collection: ShareCollection) => void
  onDelete: (collection: ShareCollection) => void
  onCopy: (url: string, doneTitle: string) => void
  onEdit: (collection: ShareCollection) => void
  onPreview: (slug: string) => void
  onOpen: (slug: string) => void
}) {
  return (
    <table className="w-full border-collapse text-left text-[length:var(--text-12)]">
      <caption className="sr-only">{t('share.collection_panel_title')}</caption>
      <thead className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        <tr className="border-b border-[var(--border-subtle)]">
          <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-3)] font-medium">{t('share.collection_col_directory')}</th>
          <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-3)] font-medium">{t('share.collection_col_members')}</th>
          <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-3)] font-medium">{t('share.collection_col_access')}</th>
          <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-3)] font-medium">{t('share.collection_col_status')}</th>
          <th scope="col" className="py-[var(--sp-1)] text-right font-medium">{t('share.collection_col_actions')}</th>
        </tr>
      </thead>
      <tbody>
        {collections.map((collection) => (
          <CollectionRow
            key={collection.id}
            collection={collection}
            isBusy={busyId === collection.id}
            onToggle={onToggle}
            onRename={onRename}
            onDelete={onDelete}
            onCopy={onCopy}
            onEdit={onEdit}
            onPreview={onPreview}
            onOpen={onOpen}
          />
        ))}
      </tbody>
    </table>
  )
}

function CollectionRow({ collection, isBusy, onToggle, onRename, onDelete, onCopy, onEdit, onPreview, onOpen }: {
  collection: ShareCollection
  isBusy: boolean
  onToggle: (collection: ShareCollection, enabled: boolean) => void
  onRename: (collection: ShareCollection) => void
  onDelete: (collection: ShareCollection) => void
  onCopy: (url: string, label: string) => void
  onEdit: (collection: ShareCollection) => void
  onPreview: (slug: string) => void
  onOpen: (slug: string) => void
}) {
  const address = directoryUrl(collection.slug)
  const marked = withChannelParam(address, collectionChannelToken(collection.slug))
  return (
    <tr className="border-b border-[var(--border-subtle)] align-top last:border-b-0">
      <th scope="row" className="max-w-prose py-[var(--sp-2)] pr-[var(--sp-3)] text-left font-normal">
        <span className="block truncate font-medium text-[var(--text-primary)]">{collection.title}</span>
        <span className="mt-[var(--sp-0-5)] block font-mono text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {`/c/${collection.slug}`}
        </span>
      </th>
      <td className="py-[var(--sp-2)] pr-[var(--sp-3)] text-[var(--text-secondary)]">
        <span className="block">{t('share.collection_members', { count: collection.count })}</span>
        <span className="mt-[var(--sp-0-5)] block text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t(targetKindKey(collection))}
        </span>
      </td>
      <td className="py-[var(--sp-2)] pr-[var(--sp-3)]">
        <span className="flex flex-wrap items-center gap-[var(--sp-0-5)]">
          {collection.hasPassword
            ? <Badge tone="warning">{t('share.passcode_protected')}</Badge>
            : <Badge tone="neutral">{t('share.collection_public')}</Badge>}
        </span>
        <span className="mt-[var(--sp-0-5)] block text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {expiryNote(collection)}
        </span>
      </td>
      <td className="py-[var(--sp-2)] pr-[var(--sp-3)]">
        {collection.isEnabled
          ? <Badge tone="success">{t('share.active')}</Badge>
          : <Badge tone="neutral">{t('share.collection_paused')}</Badge>}
      </td>
      <td className="py-[var(--sp-2)]">
        <div className="flex items-center justify-end gap-[var(--sp-0-5)]">
          {isBusy && <Spinner size={13} className="text-[var(--text-quaternary)]" />}
          <Tooltip label={t('share.collection_preview')}>
            <IconButton label={t('share.collection_preview')} size="sm" onClick={() => onPreview(collection.slug)}>
              <Eye size={13} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('share.open_link')}>
            <IconButton label={t('share.open_link')} size="sm" onClick={() => onOpen(collection.slug)}>
              <ExternalLink size={13} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip label={collection.isEnabled ? t('share.collection_pause') : t('share.collection_resume')}>
            <IconButton
              label={collection.isEnabled ? t('share.collection_pause') : t('share.collection_resume')}
              size="sm"
              disabled={isBusy}
              onClick={() => onToggle(collection, !collection.isEnabled)}
            >
              {collection.isEnabled
                ? <PauseCircle size={13} aria-hidden="true" />
                : <PlayCircle size={13} aria-hidden="true" />}
            </IconButton>
          </Tooltip>
          <Tooltip label={t('share.collection_change_access')}>
            <IconButton label={t('share.collection_change_access')} size="sm" onClick={() => onEdit(collection)}>
              <KeyRound size={13} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <RowMenu
            collection={collection}
            address={address}
            marked={marked}
            isBusy={isBusy}
            onRename={onRename}
            onCopy={onCopy}
            onDelete={onDelete}
          />
        </div>
      </td>
    </tr>
  )
}

/** The row's remaining actions, in a menu: copying, renaming and deleting do not need five visible buttons. */
function RowMenu({ collection, address, marked, isBusy, onRename, onCopy, onDelete }: {
  collection: ShareCollection
  address: string
  marked: string
  isBusy: boolean
  onRename: (collection: ShareCollection) => void
  onCopy: (url: string, label: string) => void
  onDelete: (collection: ShareCollection) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const items: MenuItem[] = [
    { id: 'copy', label: t('share.collection_copy_address'), onSelect: () => onCopy(address, t('share.collection_copied_plain')) },
    {
      id: 'copy-marked',
      label: t('share.collection_copy_marked'),
      onSelect: () => onCopy(marked, t('share.collection_copied_marked')),
    },
    { id: 'rename', label: t('share.collection_rename'), onSelect: () => onRename(collection) },
    { id: 'delete', label: t('share.collection_delete'), tone: 'danger', disabled: isBusy, separatorBefore: true, onSelect: () => onDelete(collection) },
  ]
  return (
    <>
      <IconButton
        ref={anchor}
        label={t('share.collection_row_menu_label')}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </IconButton>
      {open && <Menu anchor={anchor} open onClose={() => setOpen(false)} items={items} align="end" />}
    </>
  )
}

/**
 * What a directory looks like to somebody with no account and no privileged read.
 *
 * This goes through the public endpoint on purpose: the owner is checking what a stranger would find, and
 * an owner-side reading would answer a different question — it would show a page whose passcode was never
 * given, which is precisely the thing worth seeing before the address is sent to anyone.
 */
function CollectionPreviewDialog({ slug, onClose, onOpen }: { slug: string, onClose: () => void, onOpen: (slug: string) => void }) {
  const [data, setData] = useState<PublicCollection | null>(null)
  const [password, setPassword] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'passcode' | 'gone' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback((passcode: string) => {
    setState('loading')
    setMessage(null)
    void shareHubApi.readCollection(slug, passcode || undefined)
      .then((page) => {
        setData(page)
        setState('ready')
      })
      .catch((cause: unknown) => {
        // 401 and 404 are two answers with two different remedies, and the route keeps them apart for the
        // reader as well as for the throttle: one is a missing passcode, the other is a page that is gone.
        if (cause instanceof ApiError && cause.status === 401) setState('passcode')
        else if (cause instanceof ApiError && cause.status === 404) setState('gone')
        else {
          setState('error')
          setMessage(cause instanceof Error ? cause.message : null)
        }
      })
  }, [slug])

  useEffect(() => { load('') }, [load])

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={t('share.collection_preview_title')}
      description={t('share.collection_preview_hint')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
          <Button variant="secondary" onClick={() => onOpen(slug)}>{t('share.open_link')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-[var(--sp-3)]">
        {state === 'loading' && <LoadingBlock label={t('common.loading')} />}
        {state === 'gone' && (
          <p role="status" className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('share.collection_preview_gone')}
          </p>
        )}
        {state === 'error' && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
            {message ?? t('share.collection_load_failed')}
          </p>
        )}
        {state === 'passcode' && (
          <form
            className="flex flex-col gap-[var(--sp-2)]"
            onSubmit={(event) => {
              event.preventDefault()
              load(password)
            }}
          >
            <p role="status" className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t('share.collection_preview_locked')}
            </p>
            <Input
              type="password"
              value={password}
              autoComplete="off"
              aria-label={t('share.passcode')}
              placeholder={t('share.enter_a_passcode')}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button variant="primary" size="sm" type="submit" disabled={!password}>
              {t('share.view_content')}
            </Button>
          </form>
        )}
        {state === 'ready' && data && (
          <div className="flex flex-col gap-[var(--sp-2)]">
            <p className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{data.title}</p>
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('share.collection_preview_count', { count: data.count, shown: data.notes.length })}
            </p>
            {data.notes.length === 0 ? (
              <p className="py-[var(--sp-3)] text-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('share.collection_preview_empty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-[var(--sp-1)]">
                {data.notes.map((note) => (
                  <li key={note.slug} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-2)]">
                    <span className="flex items-center gap-[var(--sp-1)] text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                      {note.title}
                      {note.hasPassword && (
                        <Badge tone="warning"><span className="flex items-center gap-[var(--sp-0-5)]"><KeyRound size={10} aria-hidden="true" />{t('share.passcode')}</span></Badge>
                      )}
                    </span>
                    <span className="mt-[var(--sp-0-5)] block text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      {note.excerpt}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {data.nextCursor !== null && (
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('share.collection_preview_truncated', { limit: data.limit })}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function targetKindKey(collection: ShareCollection): 'share.collection_kind_folder' | 'share.collection_kind_tag' | 'share.collection_kind_manual' {
  return collection.targetType === 'folder'
    ? 'share.collection_kind_folder'
    : collection.targetType === 'tag'
      ? 'share.collection_kind_tag'
      : 'share.collection_kind_manual'
}

function expiryNote(collection: ShareCollection): string {
  if (collection.expiresAt === null) return t('share.never_expires')
  return collection.expiresAt < Date.now()
    ? t('share.collection_expired')
    : t('share.collection_expires_on', { date: fullTime(collection.expiresAt) })
}
