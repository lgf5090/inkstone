/**
 * The conversation list beside the chat.
 *
 * Rows are buttons because opening a session is the only primary action; the overflow menu carries
 * the rest and opens from either a right-click or its own button, so the same actions are reachable
 * with a keyboard.
 */
import { useEffect, useMemo, useState } from 'react'
import { MoreVertical, Pencil, Pin, Plus, Star, Trash2 } from 'lucide-react'
import type { AiChatSession } from '../../api/chat-sessions'
import { chatSessionsApi } from '../../api/chat-sessions'
import { cfErrorText } from '../../api/client'
import { useCfT } from '../../i18n'
import { formatRelative } from '../../lib/format'
import { useUi } from '../../../../store/ui'
import { cn } from '../../../../lib/cn'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Input, Segmented, commitOnEnter } from '../../../../components/form'
import { Modal, Menu, confirm, useContextMenu, type MenuItem } from '../../../../components/overlay'
import { SearchField } from '../../components/SearchField'
import {
  filterChatSessions,
  sessionDisplayTitle,
  sortChatSessions,
  type SessionFilterTab,
} from './options'
import { AiError } from './AiPanel'

export function ChatHistorySidebar({
  activeId,
  onSelect,
  onNewChat,
  onDeleted,
  onUpdated,
  refreshKey,
  className,
}: {
  activeId: string | null
  onSelect: (session: AiChatSession) => void
  onNewChat: () => void
  onDeleted: (sessionId: string) => void
  onUpdated: (session: AiChatSession) => void
  refreshKey: number
  className?: string
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [sessions, setSessions] = useState<AiChatSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<SessionFilterTab>('all')
  const [renameTarget, setRenameTarget] = useState<AiChatSession | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [menuSession, setMenuSession] = useState<AiChatSession | null>(null)
  const menu = useContextMenu()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    chatSessionsApi.list()
      .then((rows) => {
        if (cancelled) return
        setSessions(rows)
        setError(null)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setError(cfErrorText(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [refreshKey, reload])

  const visible = useMemo(
    () => sortChatSessions(filterChatSessions(sessions, tab, query)),
    [sessions, tab, query],
  )

  function closeMenu(): void {
    menu.close()
    setMenuSession(null)
  }

  function openRename(session: AiChatSession): void {
    setRenameTarget(session)
    setRenameTitle(session.title)
  }

  async function submitRename(): Promise<void> {
    if (!renameTarget || saving) return
    const title = renameTitle.trim()
    if (!title) return
    setSaving(true)
    try {
      const updated = await chatSessionsApi.update(renameTarget.id, { title })
      onUpdated(updated)
      toast({ title: t('cloudflare.ai.history.renamed'), tone: 'success' })
      setRenameTarget(null)
      setReload((value) => value + 1)
    } catch (failure: unknown) {
      toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  async function updateFlags(
    session: AiChatSession,
    patch: { pinned?: boolean; favorite?: boolean },
    message: string,
  ): Promise<void> {
    try {
      const updated = await chatSessionsApi.update(session.id, patch)
      onUpdated(updated)
      toast({ title: message, tone: 'success' })
      setReload((value) => value + 1)
    } catch (failure: unknown) {
      toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
    }
  }

  async function requestDelete(session: AiChatSession): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.ai.history.delete_confirm_title'),
      description: t('cloudflare.ai.history.delete_confirm_desc', { title: session.title || t('cloudflare.ai.new_chat') }),
      confirmLabel: t('cloudflare.ai.history.delete'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await chatSessionsApi.remove(session.id)
      toast({ title: t('cloudflare.ai.history.deleted'), tone: 'success' })
      if (activeId === session.id) onDeleted(session.id)
      setReload((value) => value + 1)
    } catch (failure: unknown) {
      toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
    }
  }

  const menuItems: MenuItem[] = menuSession ? [
    {
      id: 'rename',
      label: t('cloudflare.ai.history.rename'),
      icon: <Pencil size={14} />,
      onSelect: () => {
        const target = menuSession
        setMenuSession(null)
        openRename(target)
      },
    },
    {
      id: 'pin',
      label: menuSession.pinned ? t('cloudflare.ai.history.unpin') : t('cloudflare.ai.history.pin'),
      icon: <Pin size={14} />,
      onSelect: () => {
        const target = menuSession
        setMenuSession(null)
        void updateFlags(
          target,
          { pinned: !target.pinned },
          target.pinned ? t('cloudflare.ai.history.unpinned') : t('cloudflare.ai.history.pinned'),
        )
      },
    },
    {
      id: 'favorite',
      label: menuSession.favorite ? t('cloudflare.ai.history.unfavorite') : t('cloudflare.ai.history.favorite'),
      icon: <Star size={14} />,
      onSelect: () => {
        const target = menuSession
        setMenuSession(null)
        void updateFlags(
          target,
          { favorite: !target.favorite },
          target.favorite ? t('cloudflare.ai.history.unfavorited') : t('cloudflare.ai.history.favorited'),
        )
      },
    },
    {
      id: 'delete',
      label: t('cloudflare.ai.history.delete'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => {
        const target = menuSession
        setMenuSession(null)
        void requestDelete(target)
      },
    },
  ] : []

  const tabOptions = [
    { value: 'all' as const, label: t('cloudflare.ai.history.tab_all') },
    { value: 'pinned' as const, label: t('cloudflare.ai.history.tab_pinned') },
    { value: 'favorite' as const, label: t('cloudflare.ai.history.tab_favorite') },
  ]

  return (
    <div className={cn('flex min-h-0 flex-col bg-[var(--bg-base)]', className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('cloudflare.ai.history.title')}
        </h2>
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={onNewChat}>
          {t('cloudflare.ai.new_chat')}
        </Button>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('cloudflare.ai.history.search_placeholder')}
          label={t('cloudflare.ai.history.search_placeholder')}
        />
      </div>
      <div className="shrink-0 px-3 pb-2">
        <Segmented
          value={tab}
          options={tabOptions}
          onChange={setTab}
          size="sm"
          label={t('cloudflare.ai.history.title')}
          className="w-full"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? <AiError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
        {loading ? (
          <p role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-8 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <Spinner size={12} />
            {t('common.loading')}
          </p>
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {query.trim() ? t('cloudflare.ai.history.search_empty') : t('cloudflare.ai.history.empty')}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {visible.map((session) => {
              const active = session.id === activeId
              return (
                <li key={session.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelect(session)}
                    onContextMenu={(event) => {
                      setMenuSession(session)
                      menu.onContextMenu(event)
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 flex-col gap-0.5 rounded-[var(--r-md)] px-2 py-1.5 text-left',
                      'transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)]',
                      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                      active && 'bg-[var(--accent-soft)]',
                    )}
                  >
                    <span className={cn(
                      'flex min-w-0 items-center gap-1.5 text-[length:var(--text-12)]',
                      active ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                    )}>
                      <span className="min-w-0 flex-1 truncate">
                        {sessionDisplayTitle(session.title, t('cloudflare.ai.new_session'))}
                      </span>
                      {session.pinned ? (
                        <>
                          <Pin size={11} aria-hidden="true" className="shrink-0 text-[var(--warning)]" />
                          <span className="sr-only">{t('cloudflare.ai.history.pinned')}</span>
                        </>
                      ) : null}
                      {session.favorite ? (
                        <>
                          <Star size={11} aria-hidden="true" className="shrink-0 fill-current text-[var(--warning)]" />
                          <span className="sr-only">{t('cloudflare.ai.history.favorite')}</span>
                        </>
                      ) : null}
                    </span>
                    <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {formatRelative(session.updated_at)}
                    </span>
                  </button>
                  <IconButton
                    label={t('common.more_actions')}
                    size="xs"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setMenuSession(session)
                      menu.openAt({ x: rect.left, y: rect.bottom })
                    }}
                  >
                    <MoreVertical size={13} />
                  </IconButton>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <Menu
        anchor={menu.point ?? { x: 0, y: 0 }}
        open={menu.point !== null && menuSession !== null}
        onClose={closeMenu}
        items={menuItems}
        label={t('common.more_actions')}
        width={180}
        align="end"
      />

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={t('cloudflare.ai.history.rename_title')}
        width={400}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setRenameTarget(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!renameTitle.trim()}
              onClick={() => { void submitRename() }}
            >
              {t('common.save')}
            </Button>
          </>
        )}
      >
        <Input
          value={renameTitle}
          aria-label={t('cloudflare.ai.history.rename_title')}
          placeholder={t('cloudflare.ai.history.rename_placeholder')}
          onChange={(event) => setRenameTitle(event.target.value)}
          onKeyDown={(event) => commitOnEnter(event, () => { void submitRename() })}
        />
      </Modal>
    </div>
  )
}
