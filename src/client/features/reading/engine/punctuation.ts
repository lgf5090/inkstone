const CLOSING = /[\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\u3001\u2026\u2014\u300B\u300F\u3011\u300D\u300F\u3009]/u
const OPENING = /[\uFF08\u300A\u3010\u300C\u300E]/u

export function squeezePunctuation(root: DocumentFragment | HTMLElement, enabled: boolean): void {
  if (!enabled) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !/[\u3000-\u303f\uff00-\uff65]/u.test(node.nodeValue)) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent || parent.closest('script,style,pre,code,.reader-punctuation')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    const text = node.nodeValue ?? ''
    const fragment = document.createDocumentFragment()
    let offset = 0
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!
      if (!CLOSING.test(char) && !OPENING.test(char)) continue
      fragment.append(text.slice(offset, index))
      const span = document.createElement('span')
      span.className = 'reader-punctuation'
      span.dataset.side = OPENING.test(char) ? 'before' : 'after'
      span.textContent = char
      fragment.append(span)
      offset = index + 1
    }
    if (offset) {
      fragment.append(text.slice(offset))
      node.replaceWith(fragment)
    }
  }
}
