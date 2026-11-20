export function asciiAt(bytes: Uint8Array, start: number, text: string): boolean {
  if (start < 0 || start + text.length > bytes.length) return false
  for (let index = 0; index < text.length; index++) {
    if (bytes[start + index] !== text.charCodeAt(index)) return false
  }
  return true
}