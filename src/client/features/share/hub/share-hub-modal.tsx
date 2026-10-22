import { useEffect, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import type { ShareCategory } from '@shared/share-hub'
import type { ShareListItem } from '@shared/types'
import { Modal, Drawer, confirm } from '../../../components/overlay'
import { IconButton } from '../../../components/primitives'
import { useUi } from '../../../store/ui'
import { t, type MessageKey } from '../../../lib/i18n'
import { ApiError } from '../../../lib/api'
import { shareHubApi } from '../../../lib/api-share-hub'
import { ShareDashboardView } from '../dashboard/dashboard-view'
import { ShareCollectionsPanel } from '../collections/collections-panel'
import { ShareEditModal } from '../detail/edit-modal'
import { ShareQrModal } from '../detail/qr-modal'
import { ShareSettingsModal } from '../detail/settings-modal'
import { ShareNoteAnalyticsModal } from '../readings/note-analytics-modal'
import { ShareVisitLogModal } from '../readings/visit-log-modal'
import { ShareAuditHistory } from '../readings/audit-history'
import { HubSidebar } from './hub-sidebar'
import { HubToolbar } from './hub-toolbar'
import { ShareList } from './share-list'
import { BatchBar } from './batch-bar'
import { useShareHub } from './use-share-hub'

/**
 * The share center.
 *
 * One panel holding everything an owner can say about their public links: how many there are, which
 * of them still answer, who has read them and where from, and what to do about the ones that should
 * not be open any more.
 *
 * The shell owns exactly two things — which view the rail has selected, and which dialog is on top of
 * it. Every number is fetched by the view that draws it and every write is reported back to the hub so
 * the rail's counts move with it; a shell that also cached rows would be a third copy of the same set.
 */

/** The dialog on top of the hub, one at a time: two stacked modals cannot both own the Escape key. */
type HubDialog =
  | { kind: 'none' }
  | { kind: 'edit'; noteId: string }
  | { kind: 'qr'; row: ShareListItem }
  | { kind: 'analytics'; noteId: string; noteTitle: string }
  | { kind: 'visits'; noteId?: string; slug?: string }
  | { kind: 'audit'; noteId: string }
  | { kind: 'settings' }

export function ShareHubModal(props: {
  open: boolean
  onClose: () => void
  /** Opens the editor for one link straight away, for the call that comes from a note's toolbar. */
  initialNoteId?: string | null
}) {
  const hub = useShareHub(props.open)
  const [dialog, setDialog] = useState<HubDialog>({ kind: 'none' })
  const [railOpen, setRailOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    if (props.open && props.initialNoteId) {
      setDialog({ kind: 'edit', noteId: props.initialNoteId })
    }
  }, [props.open, props.initialNoteId])

  const close = () => {
    setDialog({ kind: 'none' })
    props.onClose()
  }

  /**
   * Every write funnels through here.
   *
   * The failure is reported with the server's own reason rather than a generic "something went wrong",
   * because the reasons a batch refuses are specific — a link revoked from another device, a tag the
   * account does not own — and a toast that hides them leaves the owner retrying the same click.
   */
  const run = async (action: () => Promise<unknown>, succeeded: string) => {
    setBusy(true)
    try {
      await action()
      toast({ title: succeeded, tone: 'success' })
      hub.refresh()
    } catch (error) {
      toast({
        title: t('share.hub_action_failed'),
        description: error instanceof ApiError ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const revokeOne = async (row: ShareListItem) => {
    const yes = await confirm({
      title: t('share.revoke_this_public_link'),
      description: t('share.anyone_who_gets_the_link_will_immediately_lose_access'),
      confirmLabel: t('share.revoke_link'),
      tone: 'danger',
    })
    if (!yes) return
    await run(() => shareHubApi.remove(row.noteId), t('share.link_revoked'))
  }

  const revokeBatch = async (noteIds: string[]) => {
    const yes = await confirm({
      title: t('share.hub_batch_revoke_title', { count: noteIds.length }),
      description: t('share.anyone_who_gets_the_link_will_immediately_lose_access'),
      confirmLabel: t('share.revoke_link'),
      tone: 'danger',
    })
    if (!yes) return
    await run(async () => {
      const res = await shareHubApi.batch.revoke(noteIds)
      // The server answers with how many links actually stopped existing, which is the number the
      // owner needs: a selection that had already lost two of them to another tab is not eight.
      toast({ title: t('share.hub_batch_revoked', { count: res.count }), tone: 'success' })
    }, t('share.link_revoked'))
  }

  const selectedIds = hub.visible
    .filter((row) => hub.selected.has(row.noteId))
    .map((row) => row.noteId)

  const listVisible = hub.category !== 'dashboard' && hub.category !== 'collections'

  const rail = (
    <HubSidebar
      category={hub.category}
      folderId={hub.folderId}
      tagName={hub.tagName}
      stats={hub.stats}
      folders={hub.folders}
      tags={hub.tags}
      onCategory={(category) => { hub.selectCategory(category); setRailOpen(false) }}
      onFolder={(folderId) => { hub.selectFolder(folderId); setRailOpen(false) }}
      onTag={(tagName) => { hub.selectTag(tagName); setRailOpen(false) }}
      onOrganizersChanged={hub.refresh}
    />
  )

  return (
    <Modal
      open={props.open}
      onClose={close}
      title={t('share.hub_title')}
      width={1240}
      bodyClassName="p-0"
      className="h-[min(84vh,900px)] min-h-[420px]"
    >
      <div className="flex h-full min-h-0">
        {/* Below `md` the rail is a drawer: twelve rows, a tree and a tag list do not fit beside a
            table on a phone, and shrinking both until they overlap is not a layout. */}
        <div className="hidden md:flex md:h-full">{rail}</div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 md:hidden">
            <IconButton
              label={t('share.hub_open_views')}
              size="sm"
              onClick={() => setRailOpen(true)}
            >
              <PanelLeft size={14}/>
            </IconButton>
            <span className="truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t(CATEGORY_TITLE_KEY[hub.category])}
            </span>
          </div>

          {hub.category === 'dashboard' && (
            <ShareDashboardView onOpenVisitLog={(noteId) => setDialog({ kind: 'visits', noteId })}/>
          )}

          {hub.category === 'collections' && (
            <ShareCollectionsPanel
              onPreview={() => {
                // The directory's own address is what the panel previews; the hub only needs to get
                // out of the way, and the panel owns the passcode gate that goes with it.
              }}
            />
          )}

          {listVisible && (
            <>
              <HubToolbar
                search={hub.search}
                onSearch={hub.setSearch}
                sort={hub.sort}
                onSort={hub.setSort}
                view={hub.view}
                onView={hub.setView}
                onRefresh={hub.refresh}
                onSettings={() => setDialog({ kind: 'settings' })}
                showLayout
              />
              <ShareList
                loading={hub.loading}
                failed={hub.failed}
                rows={hub.visible}
                view={hub.view}
                selected={hub.selected}
                folders={hub.folders}
                tags={hub.tags}
                emptyFor={t(CATEGORY_TITLE_KEY[hub.category])}
                onToggle={hub.toggle}
                onToggleAll={hub.selectAllVisible}
                onEdit={(noteId) => setDialog({ kind: 'edit', noteId })}
                onAnalytics={(noteId) => {
                  const row = hub.visible.find((entry) => entry.noteId === noteId)
                  setDialog({ kind: 'analytics', noteId, noteTitle: row?.noteTitle ?? '' })
                }}
                onVisits={(noteId) => setDialog({ kind: 'visits', noteId })}
                onQr={(row) => setDialog({ kind: 'qr', row })}
                onAudit={(noteId) => setDialog({ kind: 'audit', noteId })}
                onToggleEnabled={(row) => void run(
                  () => shareHubApi.batch.setEnabled([row.noteId], !row.isEnabled),
                  row.isEnabled ? t('share.hub_paused') : t('share.hub_resumed'),
                )}
                onRevoke={(row) => void revokeOne(row)}
                onRetry={hub.refresh}
              />
              <BatchBar
                count={selectedIds.length}
                folders={hub.folders}
                busy={busy}
                onPause={() => void run(() => shareHubApi.batch.setEnabled(selectedIds, false), t('share.hub_paused'))}
                onResume={() => void run(() => shareHubApi.batch.setEnabled(selectedIds, true), t('share.hub_resumed'))}
                onFile={(folderId) => void run(
                  () => shareHubApi.batch.organize(selectedIds, { folderId }),
                  t('share.hub_batch_filed'),
                )}
                onUnfile={() => void run(
                  () => shareHubApi.batch.organize(selectedIds, { folderId: null }),
                  t('share.hub_batch_unfiled'),
                )}
                onRevoke={() => void revokeBatch(selectedIds)}
                onClear={hub.clearSelection}
              />
            </>
          )}
        </div>
      </div>

      <Drawer open={railOpen} onClose={() => setRailOpen(false)} side="left" ariaLabel={t('share.hub_views')}>
        <div className="h-full">{rail}</div>
      </Drawer>

      {dialog.kind === 'edit' && (
        <ShareEditModal
          noteId={dialog.noteId}
          noteTitle={hub.shares.find((row) => row.noteId === dialog.noteId)?.noteTitle ?? ''}
          onClose={() => setDialog({ kind: 'none' })}
          onSaved={hub.refresh}
        />
      )}
      {dialog.kind === 'qr' && (
        <ShareQrModal
          url={dialog.row.url}
          title={dialog.row.noteTitle || t('common.untitled_note')}
          onClose={() => setDialog({ kind: 'none' })}
        />
      )}
      {dialog.kind === 'analytics' && (
        <ShareNoteAnalyticsModal
          noteId={dialog.noteId}
          noteTitle={dialog.noteTitle}
          onClose={() => setDialog({ kind: 'none' })}
        />
      )}
      {dialog.kind === 'visits' && (
        <ShareVisitLogModal
          noteId={dialog.noteId}
          slug={dialog.slug}
          onClose={() => setDialog({ kind: 'none' })}
        />
      )}
      {dialog.kind === 'settings' && <ShareSettingsModal onClose={() => setDialog({ kind: 'none' })}/>}
      {dialog.kind === 'audit' && (
        <Modal
          open
          onClose={() => setDialog({ kind: 'none' })}
          title={t('share.hub_action_history')}
          width={620}
        >
          <ShareAuditHistory noteId={dialog.noteId}/>
        </Modal>
      )}
    </Modal>
  )
}

/**
 * Which heading a rail selection is showing.
 *
 * A record rather than a lookup on the category union, so a new view has to name its own title before
 * it compiles: a header that silently fell back to the note list would make the dashboard and the
 * directories look like an empty list of links.
 */
const CATEGORY_TITLE_KEY: Record<ShareCategory, MessageKey> = {
  dashboard: 'share.dashboard_title',
  collections: 'share.collections_title',
  all: 'share.cat_all',
  active: 'share.cat_active',
  paused: 'share.cat_paused',
  pinned: 'share.cat_pinned',
  starred: 'share.cat_starred',
  password: 'share.cat_password',
  expiring_soon: 'share.cat_expiring_soon',
  expiring: 'share.cat_expiring',
  permanent: 'share.cat_permanent',
  expired: 'share.cat_expired',
}
