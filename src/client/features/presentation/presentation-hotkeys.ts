import type { Hotkey } from '../../lib/hotkeys'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { usePresentation } from '../../store/presentation'
import { startPresentationFromNote } from './start-presentation'
import { APP_SHORTCUTS } from '../../lib/shortcuts'

/** The key that starts a show, spelled once: the row in the editor's right-click menu prints this same
 * string, so the two cannot drift into showing different keys for one action. */
export const PRESENTATION_START_COMBO = APP_SHORTCUTS.present

/**
 * The show's app-level shortcut: present the note that is on screen, from wherever the keyboard
 * happens to be — including inside the editor, since the cursor's position is what decides which
 * slide the deck opens on.
 *
 * It stays quiet while a show is running. Re-running start() would rebuild the deck and jump the
 * projector back to the slide under the editor cursor, which is not what a presenter mid-talk means
 * by the key that opened the show; the overlay owns the screen and its own keys once it is up.
 */
export const PRESENTATION_HOTKEYS: Hotkey[] = [
  {
    id: 'presentation',
    combo: APP_SHORTCUTS.present,
    description: () => t('workspace.presentation_mode'),
    group: () => t('common.note'),
    allowInInput: true,
    enabled: () => !usePresentation.getState().open,
    handler: () => {
      const noteId = useUi.getState().activeNoteId
      if (noteId) startPresentationFromNote(noteId)
    },
  },
]
