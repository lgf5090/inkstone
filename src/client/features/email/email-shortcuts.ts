import { useEffect, useRef } from 'react'
import { isEditableTarget, matches, registerAll, type Hotkey } from '../../lib/hotkeys'
import { t } from '../../lib/i18n'

const EMAIL_SHORTCUTS = {
  compose: 'c',
  reply: 'r',
  replyAll: 'a',
  forward: 'f',
  archive: 'e',
  trash: 'shift+3',
  delete: 'delete',
  toggleRead: 'u',
  toggleStar: 's',
  search: '/',
  inboxPrefix: 'g',
} as const

const INBOX_KEY = 'i'
const SEQUENCE_TIMEOUT_MS = 1500

export type EmailShortcutReplyMode = 'reply' | 'reply-all' | 'forward'

export interface EmailShortcutActions {
  composeNew: () => void
  reply: (mode: EmailShortcutReplyMode) => void
  canCompose: () => boolean
  canReply: () => boolean
  archive: () => void
  trash: () => void
  toggleRead: () => void
  toggleStar: () => void
  focusSearch: () => void
  goInbox: () => void
}

function emailHotkeys(getActions: () => EmailShortcutActions, armInbox: (event: KeyboardEvent) => void): Hotkey[] {
  const group = (): string => t('email.shortcuts.group')
  return [
    {
      id: 'email-compose',
      combo: EMAIL_SHORTCUTS.compose,
      description: () => t('email.compose.title_new'),
      group,
      enabled: () => getActions().canCompose(),
      handler: () => getActions().composeNew(),
    },
    {
      id: 'email-reply',
      combo: EMAIL_SHORTCUTS.reply,
      description: () => t('email.detail.reply'),
      group,
      enabled: () => getActions().canReply(),
      handler: () => getActions().reply('reply'),
    },
    {
      id: 'email-reply-all',
      combo: EMAIL_SHORTCUTS.replyAll,
      description: () => t('email.detail.reply_all'),
      group,
      enabled: () => getActions().canReply(),
      handler: () => getActions().reply('reply-all'),
    },
    {
      id: 'email-forward',
      combo: EMAIL_SHORTCUTS.forward,
      description: () => t('email.detail.forward'),
      group,
      enabled: () => getActions().canReply(),
      handler: () => getActions().reply('forward'),
    },
    {
      id: 'email-archive',
      combo: EMAIL_SHORTCUTS.archive,
      description: () => t('email.message.archive'),
      group,
      handler: () => getActions().archive(),
    },
    {
      id: 'email-trash',
      combo: EMAIL_SHORTCUTS.trash,
      description: () => t('email.detail.delete'),
      group,
      handler: () => getActions().trash(),
    },
    {
      id: 'email-delete',
      combo: EMAIL_SHORTCUTS.delete,
      description: () => t('email.detail.delete'),
      group,
      handler: () => getActions().trash(),
    },
    {
      id: 'email-toggle-read',
      combo: EMAIL_SHORTCUTS.toggleRead,
      description: () => t('email.shortcuts.toggle_read'),
      group,
      handler: () => getActions().toggleRead(),
    },
    {
      id: 'email-toggle-star',
      combo: EMAIL_SHORTCUTS.toggleStar,
      description: () => t('email.shortcuts.toggle_star'),
      group,
      handler: () => getActions().toggleStar(),
    },
    {
      id: 'email-search',
      combo: EMAIL_SHORTCUTS.search,
      description: () => t('email.shortcuts.search'),
      group,
      handler: () => getActions().focusSearch(),
    },
    {
      id: 'email-inbox-prefix',
      combo: EMAIL_SHORTCUTS.inboxPrefix,
      description: () => t('email.shortcuts.go_inbox'),
      group,
      handler: (event) => armInbox(event),
    },
  ]
}

export function useEmailShortcuts(actions: EmailShortcutActions): void {
  const latest = useRef(actions)
  latest.current = actions

  useEffect(() => {
    let sequenceTimer: number | null = null
    let pending: KeyboardEvent | null = null

    const reset = (): void => {
      pending = null
      if (sequenceTimer !== null) {
        window.clearTimeout(sequenceTimer)
        sequenceTimer = null
      }
    }

    const armInbox = (event: KeyboardEvent): void => {
      reset()
      pending = event
      sequenceTimer = window.setTimeout(reset, SEQUENCE_TIMEOUT_MS)
    }

    const follow = (event: KeyboardEvent): void => {
      if (pending === null || event === pending) return
      if (typeof event.getModifierState !== 'function') return
      reset()
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (isEditableTarget(event.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      if (!matches(event, INBOX_KEY)) return
      event.preventDefault()
      event.stopPropagation()
      latest.current.goInbox()
    }

    const dispose = registerAll(emailHotkeys(() => latest.current, armInbox))
    window.addEventListener('keydown', follow, true)
    return () => {
      window.removeEventListener('keydown', follow, true)
      reset()
      dispose()
    }
  }, [])
}
