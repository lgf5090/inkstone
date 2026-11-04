/**
 * A snippet as a shareable picture.
 *
 * The card is drawn on a canvas rather than a DOM screenshot so it needs no layout pass, works on a
 * phone, and follows the reader's current theme tokens. Only the first 48 lines are drawn; the card
 * says how many were left rather than pretending the picture is the file.
 */
const MAX_LINES = 48

function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function drawCodeCard({ title, fileLabel, content }: { title: string; fileLabel: string; content: string }): HTMLCanvasElement {
  const lines = content.split('\n')
  const shown = lines.slice(0, MAX_LINES)
  const width = 1200
  const lineHeight = 26
  const header = 104
  const footer = 44
  const height = header + shown.length * lineHeight + footer
  const canvas = document.createElement('canvas')
  const scale = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = width * scale
  canvas.height = height * scale
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw the card')
  context.scale(scale, scale)

  context.fillStyle = token('--bg-surface', '#fffdf9')
  context.fillRect(0, 0, width, height)
  context.fillStyle = token('--bg-sunken', '#f1e9df')
  context.fillRect(0, 0, width, header)
  context.strokeStyle = token('--border-subtle', '#e4d8ca')
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(0, header)
  context.lineTo(width, header)
  context.stroke()

  context.fillStyle = token('--text-primary', '#2d2824')
  context.font = '600 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  context.fillText(title.slice(0, 64), 36, 44)
  context.fillStyle = token('--text-quaternary', '#776b62')
  context.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.fillText(fileLabel.slice(0, 80), 36, 74)

  context.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace'
  shown.forEach((line, index) => {
    const y = header + 30 + index * lineHeight
    context.fillStyle = token('--text-quaternary', '#8a7d72')
    context.fillText(String(index + 1).padStart(3, ' '), 24, y)
    context.fillStyle = token('--text-primary', '#2d2824')
    context.fillText(line.replace(/\t/g, '  ').slice(0, 110), 78, y)
  })

  context.fillStyle = token('--text-quaternary', '#776b62')
  context.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  const suffix = lines.length > MAX_LINES ? ` · ${lines.length - MAX_LINES} more lines` : ''
  context.fillText(`${lines.length} lines${suffix}`, 24, height - 16)
  return canvas
}

export async function exportCodeCard(input: { title: string; fileLabel: string; content: string }): Promise<void> {
  const canvas = drawCodeCard(input)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The card could not be encoded')
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${input.title.replace(/[\\/:*?"<>|]/g, '-') || 'snippet'}.png`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
