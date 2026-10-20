/**
 * The notification centre: what the schedules delivered.
 *
 * It is a drawer rather than a page because a reminder is read on the way past, not navigated to.
 * The bodies arrive as Markdown from the digest and from an AI routine, so they are rendered through
 * the same sanitized pipeline as a reply rather than as raw text.
 */
import { Z_INDEX } from '../../lib/z-index'
import { useEffect, useMemo, useState } from 'react'
import { Check, Trash2, Wallet } from 'lucide-react'
import type { AssistantNotification } from '@shared/assistant'
import { cn } from '../../lib/cn'
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
              <span className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {unread > 0 ? t('assistant.notifications.unread', { count: unread }) : t('assistant.notifications.all_read')}
              </span>
              {unread > 0 && (
                <Button size="sm" variant="ghost" icon={<Check size={13} />} onClick={() => void markRead()}>
                  {t('assistant.notifications.mark_all')}
                </Button>
              )}
            </div>
            {/* The rows are one card rather than a stack of floating boxes: at 380px the per-row border
                doubled the visible edges and made a short list read as three unrelated things. */}
            <div className="mx-2 mb-3 min-h-0 flex-1 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              <ul className="no-scrollbar h-full overflow-y-auto">
                {notifications.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onRead={() => void markRead(notification.id)}
                    onDelete={() => void remove(notification.id)}
                  />
                ))}
              </ul>
            </div>
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
    <li className="border-b border-[var(--border-subtle)] last:border-b-0">
      <div className="px-3 py-2.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)]">
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
            <p className={cn(
              'flex items-center gap-1.5 text-[length:var(--text-12-5)]',
              unread ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
            )}>
              {unread && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />}
              <span className="min-w-0 truncate">{notification.title}</span>
            </p>
            <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{relativeTime(notification.createdAt)}</p>
          </button>
          {/* A delivery about a plan can be opened; one from a routine cannot, and the control is not
              offered when there is nothing behind it. */}
          {notification.subscriptionId && (
            <IconButton
              label={t('assistant.notifications.open_subscription')}
              size="xs"
              onClick={() => void import('../subscriptions/open-subscription').then((module) => module.openSubscriptionById(notification.subscriptionId!))}
            >
              <Wallet size={12} />
            </IconButton>
          )}
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
