export function sanitizedElement(html: string): HTMLElement {
  const document = typeof Document.parseHTMLUnsafe === 'function'
    ? Document.parseHTMLUnsafe(html)
    : new DOMParser().parseFromString(html, 'text/html')
  return document.body
}

export function insertSanitizedHtml(target: Element, html: string): void {
  if ('setHTMLUnsafe' in Element.prototype) target.setHTMLUnsafe(html)
  else target.innerHTML = html
}