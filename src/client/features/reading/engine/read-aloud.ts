export interface SpeechSentence {
  text: string
  start: number
  end: number
}

export function splitSpeechSentences(text: string, offset = 0): SpeechSentence[] {
  const sentences: SpeechSentence[] = []
  const pattern = /[^.!?\u3002\uff01\uff1f\n]+(?:[.!?\u3002\uff01\uff1f]+|$)/g
  for (const match of text.matchAll(pattern)) {
    const value = match[0].trim()
    if (!value) continue
    const leading = match[0].length - match[0].trimStart().length
    const start = offset + (match.index ?? 0) + leading
    sentences.push({ text: value, start, end: start + value.length })
  }
  return sentences
}
