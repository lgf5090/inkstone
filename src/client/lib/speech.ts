export interface SpeakHandlers {
  onDone?: () => void
  onError?: () => void
  onBoundary?: (charIndex: number) => void
}

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function'
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel()
}

export function pauseSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.pause()
}

export function resumeSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.resume()
}

export function speak(text: string, language: string, handlers: SpeakHandlers = {}, rate = 1): boolean {
  if (!canSpeak() || !text.trim()) return false
  window.speechSynthesis.cancel()
  const utterance = new window.SpeechSynthesisUtterance(text)
  utterance.lang = language
  utterance.rate = Math.min(2, Math.max(0.5, rate))
  utterance.onend = () => handlers.onDone?.()
  utterance.onerror = () => handlers.onError?.()
  utterance.onboundary = (event) => handlers.onBoundary?.(event.charIndex)
  window.speechSynthesis.speak(utterance)
  return true
}
