/**
 * The notification centre: what the schedules delivered.
 *
 * It is a drawer rather than a page because a reminder is read on the way past, not navigated to — unless
 * it names where it came from, which is the other thing a row can be. The bodies arrive as Markdown from
 * the digest and from an AI routine, so they are rendered through the same sanitized pipeline as a reply
 * rather than as raw text.
 */
import { Z_INDEX } from '../../lib/z-index'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Check, Clock, Trash2, Wallet } from 'lucide-react'
import type { AssistantNotification } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { Button, IconButton } from '../../components/primitives'
import { Drawer, Menu, Tooltip, type MenuItem } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { taskIdFromNotificationLink } from '../todos/todo-address'
import { openTaskInTodo } from '../todos/open-task'
import { snoozeLabel, useTodos } from '../todos/store'
import { SNOOZE_MINUTES } from '@shared/todos/model'
import { useAssistant } from './assistant-store'

/**
 * The header control that opens the centre.
 *
 * Two surfaces wear one — the chat header and the subscriptions header — and the badge is the same
 * arithmetic in both, so it is written once here rather than in two toolbars that would drift. The count is
 * read on mount because the bell cannot be a quiet zero: on a plan nothing else ever asks for it, and on the
 * chat tab the container's own bootstrap asks in the same tick, where the store answers both with one read.
 */
export function NotificationsBell({ open, onOpen, onClose }: { open: boolean, onOpen: () => void, onClose: () => void }) {
  const unread = useAssistant((state) => state.unread)

  useEffect(() => {
    void useAssistant.getState().loadNotifications()
  }, [])

  return (
    <>
      <Tooltip label={unread ? t('assistant.notifications.unread', { count: unread }) : t('assistant.notifications.title')}>
        <IconButton label={t('assistant.notifications.title')} size="sm" onClick={onOpen}>
          <span className="relative">
            <Bell size={15} />
            {unread > 0 && (
              <span
                className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--danger)] px-[3px] text-[length:var(--text-9)] font-semibold text-[var(--danger-contrast)]"
              >
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </span>
        </IconButton>
      </Tooltip>
      <NotificationCenter open={open} onClose={onClose} />
    </>
  )
}

export function NotificationCenter({ open, onClose }: { open: boolean, onClose: () => void }) {
  const notifications = useAssistant((state) => state.notifications)
  const unread = useAssistant((state) => state.unread)
  const loadNotifications = useAssistant((state) => state.loadNotifications)
  const markRead = useAssistant((state) => state.markRead)
  const remove = useAssistant((state) => state.removeNotification)

  useEffect(() => {
    if (open) void loadNotifications()
  }, [open, loadNotifications])

  /**
   * Put the drawer away before the screen changes.
   *
   * It is a visitor over whatever tab it was opened from, so leaving it up would cover the very task the
   * reader pressed for — and a drawer holding focus on a screen they have moved off is not a thing they can
   * get back to without pressing the notice a second time.
   */
  const openTask = (taskId: string): void => {
    onClose()
    void openTaskInTodo(taskId)
  }

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
                    onOpenSubscription={(id) => {
                      // The reader pressed this to be taken somewhere else, and the centre covers the very
                      // panel the plan opens in, so it has to get out of the way first.
                      onClose()
                      void import('../subscriptions/open-subscription').then((module) => module.openSubscriptionById(id))
                    }}
                    onOpenTask={openTask}
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
  onOpenSubscription,
  onOpenTask,
}: {
  /** A delivered notice; its `link` is what decides whether a press opens a task. */
  notification: AssistantNotification
  onRead: () => void
  onDelete: () => void
  onOpenSubscription: (id: string) => void
  onOpenTask: (taskId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const snooze = useTodos((state) => state.snoozeTask)
  const snoozeRef = useRef<HTMLButtonElement>(null)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const unread = notification.readAt === null
  // Either the notice names a screen this app can open, or it is a message and pressing it reads the rest
  // of it here. A pointer this app cannot read — another app's prefix, a tail that is not one id — is the
  // second case, which is the honest answer rather than a press that goes nowhere.
  const taskId = taskIdFromNotificationLink(notification.link)
  const html = useMemo(() => ({ __html: renderMarkdown(notification.body).html }), [notification.body])
  // Only a notice that points at a task can be snoozed: the others have nothing to remind about. The
  // four durations append a reminder and leave the task's own list alone, exactly like the card menu.
  const snoozeItems: MenuItem[] = taskId
    ? SNOOZE_MINUTES.map((minutes) => ({
      id: `snooze-${minutes}`,
      label: snoozeLabel(minutes),
      onSelect: () => {
        setSnoozeOpen(false)
        onRead()
        void snooze(taskId, minutes)
      },
    }))
    : []
  // A collapsed row shows one line; expanding it must not re-parse the body on every keystroke.
  return (
    <li className="border-b border-[var(--border-subtle)] last:border-b-0">
      <div className="px-3 py-2.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)]">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => {
              if (unread) onRead()
              if (taskId) { onOpenTask(taskId); return }
              setExpanded((value) => !value)
            }}
            aria-expanded={taskId ? undefined : expanded}
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
            {/* Saying what the press does, rather than leaving the reader to find out by pressing it: a row
                that navigates and a row that expands are different gestures and must not look the same. */}
            {taskId && (
              <p className="mt-0.5 text-[length:var(--text-10-5)] font-medium text-[var(--accent)]">{t('assistant.notifications.open_task')}</p>
            )}
          </button>
          {/* A delivery about a plan can be opened; one from a routine cannot, and the control is not
              offered when there is nothing behind it. */}
          {notification.subscriptionId && (
            <IconButton
              label={t('assistant.notifications.open_subscription')}
              size="xs"
              onClick={() => { if (notification.subscriptionId) onOpenSubscription(notification.subscriptionId) }}
            >
              <Wallet size={12} />
            </IconButton>
          )}
          {taskId && (
            <button
              ref={snoozeRef}
              type="button"
              aria-label={t('todo.snooze.label')}
              aria-haspopup="menu"
              aria-expanded={snoozeOpen}
              onClick={() => setSnoozeOpen((value) => !value)}
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-quaternary)] hover:text-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <Clock size={13} />
            </button>
          )}
          <IconButton label={t('assistant.notifications.delete')} size="xs" onClick={onDelete}>
            <Trash2 size={12} />
          </IconButton>
        </div>
        <Menu anchor={snoozeRef} open={snoozeOpen} onClose={() => setSnoozeOpen(false)} items={snoozeItems} align="end" width={184} label={t('todo.snooze.label')} />
        {expanded && (
          <div className="ink-prose ink-chat-prose mt-1.5 border-t border-[var(--border-subtle)] pt-1.5 text-[length:var(--text-12)]" dangerouslySetInnerHTML={html} />
        )}
      </div>
    </li>
  )
}
