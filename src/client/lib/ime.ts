import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * The keyCode an IME keystroke carries: 229 means "Process", i.e. the input method owns this key.
 *
 * `isComposing` is false on the keystroke that *accepts* a candidate in some browsers, which is exactly
 * the one that used to run the action underneath - the classic "Enter picks the word and submits the
 * form" bug. Checking the keyCode catches that frame even when the flag has already been cleared.
 */
const IME_PROCESS_KEY_CODE = 229

/**
 * True while an input method owns the keystroke, so a key handler should leave the key to it.
 *
 * During a Chinese or Japanese composition Enter selects a candidate, Escape cancels it and the arrows
 * page the candidate list. A handler that reads the same key commits half a word and then fires the
 * action the user was still typing, so every bare-key handler on an editable element has to answer this
 * first. `tests/client-ime-guard.test.ts` is what keeps new ones from forgetting.
 */
export function isImeComposing(event: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return native.isComposing || event.keyCode === IME_PROCESS_KEY_CODE
}
