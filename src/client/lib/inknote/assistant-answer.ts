/** Lays an assistant answer onto a page as text boxes, paragraph by paragraph, top to bottom. */
export interface AnswerBox {
  x: number
  y: number
  w: number
  h: number
  text: string
  fontSize: number
}

export function answerTextBoxes(text: string, options: { pageHeight: number; textSize: number; maxY?: number }): AnswerBox[] {
  const maxY = options.maxY ?? 0.92
  const boxes: AnswerBox[] = []
  let top = 0.08
  for (const paragraph of text.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean).slice(0, 12)) {
    const lines = Math.max(1, Math.ceil(paragraph.length / 40))
    const height = Math.min(0.35, lines * options.textSize * 1.3 / Math.max(1, options.pageHeight) + 0.02)
    if (top + height > maxY) break
    boxes.push({ x: 0.06, y: top, w: 0.88, h: height, text: paragraph, fontSize: options.textSize })
    top += height + 0.02
  }
  return boxes
}
