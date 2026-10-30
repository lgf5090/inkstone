import { isImeComposing } from '../../../../lib/ime'

/**
 * Cmd/Ctrl+Enter sends the active request from anywhere in the module.
 *
 * The URL field's own Enter handler answers the bare key only, so the two paths cannot both fire
 * for one keystroke. An IME frame is excluded the same way every other bare-key handler here is.
 */
export function isSendShortcut(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return false
  if (event.defaultPrevented || isImeComposing(event)) return false
  return true
}
