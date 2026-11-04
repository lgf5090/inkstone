/** Handing a generated file to the reader without a server round trip. */
export function downloadBlob(filename: string, content: string | Blob, mime = 'text/plain;charset=utf-8'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.click()
  // The object URL pins the bytes until it is released; one frame is enough for the click to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A filename that cannot escape the download folder or surprise a shell. */
export function safeFilename(name: string, fallback: string, extension: string): string {
  const base = name
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${base || fallback}${base.endsWith(extension) ? '' : extension}`
}
