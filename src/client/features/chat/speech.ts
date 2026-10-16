/**
 * Reading a reply aloud.
 *
 * The browser's own speech synthesis is the only engine available without a key and without shipping a
 * voice, so this is a thin wrapper rather than a feature: it strips the Markdown first, because a
 * screen reader that spells out `##` and `**` is worse than not offering the button, and it refuses
 * quietly where the API is missing instead of throwing inside a click handler.
 */

/** Whether this browser can read anything aloud. */
export function canSpeak(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function'
}

/** Stops whatever is being read, if anything is. */
export function stopSpeaking(): void {
  if (!canSpeak()) return
  window.speechSynthesis.cancel()
}

/**
 * Reads `text` in `language`, replacing whatever was being read.
 *
 * Replacing rather than queueing: a reader who presses read on a second reply wants that one, and two
 * voices talking over each other is the failure this avoids.
 */
export function speak(text: string, language: string): boolean {
  if (!canSpeak() || !text.trim()) return false
  window.speechSynthesis.cancel()
  const utterance = new window.SpeechSynthesisUtterance(text)
  utterance.lang = language
  window.speechSynthesis.speak(utterance)
  return true
}
