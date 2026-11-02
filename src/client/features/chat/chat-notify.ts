import type { AssistantSettings } from '@shared/assistant'

export type ChatNotificationKind = 'approval' | 'finish'

/**
 * Whether this event should announce itself.
 *
 * The reader's answer is the whole rule: a channel they turned off stays off, a kind they turned off stays
 * quiet, and an unfocused-only preference means a person already looking at the thread is not interrupted.
 */
export function notificationWanted(
  settings: Pick<AssistantSettings, 'notifyChannel' | 'notifyOnlyUnfocused' | 'notifyApproval' | 'notifyFinish'>,
  kind: ChatNotificationKind,
  focused: boolean,
): boolean {
  if (settings.notifyChannel === 'off') return false
  if (kind === 'approval' && !settings.notifyApproval) return false
  if (kind === 'finish' && !settings.notifyFinish) return false
  if (settings.notifyOnlyUnfocused && focused) return false
  return true
}

function playChime(): void {
  try {
    const AudioCtor = window.AudioContext
    if (!AudioCtor) return
    const context = new AudioCtor()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.24)
    oscillator.onended = () => { void context.close() }
  } catch {
    // A browser that refuses audio has already shown the notification; a silenced chime is not an error.
  }
}

/**
 * Says one thing once. The browser notification is only drawn when permission already exists — this app
 * never asks for it from a turn, because a permission prompt that appears because a model finished is
 * exactly the kind of prompt readers learn to deny.
 */
export function announceChat(settings: AssistantSettings, kind: ChatNotificationKind, title: string, body: string): void {
  const focused = typeof document !== 'undefined' && document.hasFocus()
  if (!notificationWanted(settings, kind, focused)) return
  if ((settings.notifyChannel === 'sound' || settings.notifyChannel === 'both') && typeof window !== 'undefined') playChime()
  if (settings.notifyChannel === 'browser' || settings.notifyChannel === 'both') {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    try {
      new Notification(title, { body, tag: `inkstone-chat-${kind}` })
    } catch {
      // Some browsers throw for a notification created outside a service worker; the chime already ran.
    }
  }
}
