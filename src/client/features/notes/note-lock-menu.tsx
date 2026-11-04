/**
 * The lock entries both note menus share, so the list row and the explorer row cannot drift apart.
 *
 * Lock state is passed in rather than read here: the menu is rebuilt by the component that already
 * subscribes to the session's unlocked ids, and reading `getState()` in this helper would leave the
 * "Lock again" entry stale until an unrelated re-render.
 */
import { KeyRound, Lock, Unlock } from 'lucide-react'
import type { MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { decryptNoteFromMenu, lockNoteFromMenu, relockNoteFromMenu, unlockNoteFromMenu } from './note-lock-actions'

export function noteLockMenuItems(note: { id: string; isEncrypted?: boolean }, unlocked: boolean): MenuItem[] {
  // The demo backend has no server-side lock state; offering the action there would store ciphertext
  // as ordinary text and show it back to the reader.
  if (IS_DEMO_MODE) return []
  if (!note.isEncrypted) {
    return [{
      id: 'lock-note',
      label: t('notelock.menu_lock'),
      icon: <Lock size={13}/>,
      onSelect: () => void lockNoteFromMenu(note.id),
    }]
  }
  const stateItem: MenuItem = unlocked
    ? {
        id: 'relock-note',
        label: t('notelock.menu_relock'),
        icon: <Lock size={13}/>,
        onSelect: () => relockNoteFromMenu(note.id),
      }
    : {
        id: 'unlock-note',
        label: t('notelock.menu_unlock'),
        icon: <Unlock size={13}/>,
        onSelect: () => void unlockNoteFromMenu(note.id),
      }
  return [
    stateItem,
    {
      id: 'decrypt-note',
      label: t('notelock.menu_remove'),
      icon: <KeyRound size={13}/>,
      tone: 'danger',
      onSelect: () => void decryptNoteFromMenu(note.id),
    },
  ]
}
