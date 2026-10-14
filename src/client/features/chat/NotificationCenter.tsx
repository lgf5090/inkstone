/**
 * The notification centre: what the schedules delivered.
 *
 * It is a drawer rather than a page because a reminder is read on the way past, not navigated to.
 * The bodies arrive as Markdown from the digest and from an AI routine, so they are rendered through
 * the same sanitized pipeline as a reply rather than as raw text.
 */
import { Z_INDEX } from '../../lib/z-index'
import { useEffect, useMemo, useState } from 'react'
import { Check, Trash2 } from 'lucide-react'
import type { AssistantNotification } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { Button, IconButton } from '../../components/primitives'
import { Drawer } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { useAssistant } from './assistant-store'

export function NotificationCenter({ open, onClose }: { open: boolean, onClose: () => void }) {
  const notifications = useAssistant((state) => state.notifications)
  const unread = useAssistant((state) => state.unread)
  const loadNotifications = useAssistant((state) => state.loadNotifications)
  const markRead = useAssistant((state) => state.markRead)
  const remove = useAssistant((state) => state.removeNotification)

  useEffect(() => {
    if (open) void loadNotifications()
  }, [open, loadNotifications])

  return (
    <Drawer open={open} onClose={onClose} side="right" width={380} title={t('assistant.notifications.title')} zIndex={Z_INDEX.pinnedMenu}>
      <div className="flex h-full min-h-0 flex-col">
        {notifications.length === 0 ? (
          <Empty art="select" title={t('assistant.notifications.empty')} description={t('assistant.notifications.empty_hint')} compact />
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {unread > 0 ? t('assistant.notifications.unread', { count: unread }) : t('assistant.notifications.all_read')}
              </span>
              {unread > 0 && (
                <Button size="sm" variant="ghost" icon={<Check size={13} />} onClick={() => void markRead()}>
                  {t('assistant.notifications.mark_all')}
                </Button>
              )}
            </div>
            <ul className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onRead={() => void markRead(notification.id)}
                  onDelete={() => void remove(notification.id)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </Drawer>
  )
}

function NotificationRow({
  notification,
  onRead,
  onDelete,
}: {
  notification: AssistantNotification
  onRead: () => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const unread = notification.readAt === null
  const html = useMemo(() => ({ __html: renderMarkdown(notification.body).html }), [notification.body])
  // A collapsed row shows one line; expanding it must not re-parse the body on every keystroke.
  return (
    <li className="mb-1">
      <div
        className={unread
          ? 'rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-2'
          : 'rounded-[var(--r-md)] border border-transparent px-2.5 py-2'}
      >
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => {
              setExpanded((value) => !value)
              if (unread) onRead()
            }}
            aria-expanded={expanded}
            className="min-w-0 flex-1 text-left"
          >
            <p className="flex items-center gap-1.5 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
              {unread && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />}
              <span className="min-w-0 truncate">{notification.title}</span>
            </p>
            <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{relativeTime(notification.createdAt)}</p>
          </button>
          <IconButton label={t('assistant.notifications.delete')} size="xs" onClick={onDelete}>
            <Trash2 size={12} />
          </IconButton>
        </div>
        {expanded && (
          <div className="ink-prose ink-chat-prose mt-1.5 border-t border-[var(--border-subtle)] pt-1.5 text-[length:var(--text-12)]" dangerouslySetInnerHTML={html} />
        )}
      </div>
    </li>
  )
}
