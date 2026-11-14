/**
 * The words a reader typed but did not send, kept against the conversation they belong to.
 *
 * Switching threads used to leave the half-written question in the box, where the next press sent it to
 * the wrong conversation; a reload lost it altogether. A draft is local, unsent text rather than chat
 * history, so localStorage is the right place and the scope is the thread id (or `new` before a thread
 * exists). A temporary conversation opts out entirely: its promise is that nothing is kept.
 */

const PREFIX = 'inkstone.chat.draft.'
const NEW_THREAD = 'new'

/** Which box a draft belongs to, or null when this conversation must keep nothing. */
export function draftScope(activeId: string | null, ephemeral: boolean): string | null {
  return ephemeral ? null : (activeId ?? NEW_THREAD)
}

export function readDraft(scope: string | null): string {
  if (!scope) return ''
  try { return localStorage.getItem(PREFIX + scope) ?? '' } catch { return '' }
}

export function writeDraft(scope: string | null, text: string): void {
  if (!scope) return
  try {
    if (text) localStorage.setItem(PREFIX + scope, text)
    else localStorage.removeItem(PREFIX + scope)
  } catch {
    // A full or disabled store must not stop the reader from typing in the box.
  }
}
