import { fenceBody } from '../../lib/markdown/fence-bodies'
import { kanbanIndex } from '../../lib/markdown/kanban/view'

export function patchChildren(destEl: HTMLElement, srcEl: HTMLElement): void {
  const destChildren = destEl.childNodes
  const srcChildren = srcEl.childNodes
  const srcLen = srcChildren.length
  let destLen = destChildren.length

  while (destLen > srcLen) {
    destEl.removeChild(destChildren[destLen - 1]!)
    destLen--
  }

  for (let i = 0; i < srcLen; i++) {
    const srcChild = srcChildren[i]!
    if (i < destLen) {
      const destChild = destChildren[i]!
      if (destChild.nodeType === srcChild.nodeType && destChild.nodeName === srcChild.nodeName) {
        patchDom(destChild, srcChild)
      } else {
        destEl.replaceChild(srcChild.cloneNode(true), destChild)
      }
    } else {
      destEl.appendChild(srcChild.cloneNode(true))
    }
  }
}

export function patchDom(dest: Node, src: Node): void {
  if (dest.nodeType !== src.nodeType || dest.nodeName !== src.nodeName) {
    dest.parentElement?.replaceChild(src.cloneNode(true), dest)
    return
  }

  if (dest.nodeType === Node.TEXT_NODE) {
    if (dest.nodeValue !== src.nodeValue) {
      dest.nodeValue = src.nodeValue
    }
    return
  }

  if (dest.nodeType === Node.ELEMENT_NODE) {
    const destEl = dest as HTMLElement
    const srcEl = src as HTMLElement

    if (destEl.hasAttribute('data-mermaid') && srcEl.hasAttribute('data-mermaid')) {
      if (destEl.getAttribute('data-mermaid') === srcEl.getAttribute('data-mermaid') && destEl.dataset.rendered) {
        return
      }
    }

    // A drawn chart is a canvas plus a live instance, and neither is in innerHTML, so re-syncing this
    // subtree from the staging copy would put the placeholder text back over a chart that did not change.
    // The stated format is compared beside the body: which reader draws a chart is not written anywhere
    // in its body text, so a note that only moved `style=` has to look changed here.
    if (destEl.hasAttribute('data-chart') && srcEl.hasAttribute('data-chart')) {
      if (destEl.getAttribute('data-chart') === srcEl.getAttribute('data-chart') &&
        destEl.getAttribute('data-chart-style') === srcEl.getAttribute('data-chart-style') &&
        destEl.dataset.rendered &&
        !srcEl.classList.contains('chart-source')) {
        // The body did not change, so the picture still stands. Except when the staged copy is showing
        // its source instead: that is the renderer switch having been turned off, and the note text is
        // identical either way, so the class is the only thing that says the block must stop being a
        // canvas. Preserving it there left an off switch with a chart still drawn on screen.
        // The line is still re-stamped: a format toggle changes how many lines a block above occupies,
        // which moves this one, and the line is what the toolbar resolves its write against.
        if (destEl.dataset.line !== srcEl.dataset.line) destEl.dataset.line = srcEl.dataset.line
        return
      }
    }

    // A query block holds an answer built from other notes, and none of it is in the staged markup:
    // re-syncing the subtree would put the loading placeholder back over a table that did not change,
    // and the reader would watch it blink on every keystroke. The two hosts are the same block when the
    // query text in `data-dataview` is identical, which is the one thing a re-render cannot move.
    if (destEl.hasAttribute('data-dataview') && srcEl.hasAttribute('data-dataview') &&
      destEl.dataset.dataview === srcEl.dataset.dataview &&
      !destEl.classList.contains('loading')) {
      if (destEl.dataset.line !== srcEl.dataset.line) destEl.dataset.line = srcEl.dataset.line
      return
    }

    // A mounted board is a React root living inside this element, and none of it is in innerHTML:
    // re-syncing the subtree would put the renderer's placeholder back over a board that did not
    // change, and the reader would lose the column they had scrolled to. The two bodies are compared
    // through the fence set each copy was registered with, because the body is deliberately not an
    // attribute here — and an empty answer on either side means unregistered markup, which is never
    // a match worth preserving.
    if (destEl.hasAttribute('data-kanban') && srcEl.hasAttribute('data-kanban') &&
      destEl.querySelector('[data-kanban-canvas]') &&
      !srcEl.classList.contains('kanban-source')) {
      const live = fenceBody(destEl, 'kanban', kanbanIndex(destEl))
      if (live !== '' && live === fenceBody(srcEl, 'kanban', kanbanIndex(srcEl))) {
        // The line is still re-stamped: a block above changing its line count moves this one, and the
        // line is what a write resolves its fence against.
        if (destEl.dataset.line !== srcEl.dataset.line) destEl.dataset.line = srcEl.dataset.line
        return
      }
    }

    // A live map is an instance whose element the registry re-parents into this block's placeholder,
    // and none of that is in `innerHTML`. Re-syncing the subtree from the staged copy would put the
    // loading text back over a map that did not change, and the registry would then find its own
    // container detached from the document on the next keystroke. The palette annotation is compared
    // beside the body for the same reason a chart's stated format is: which palette a map draws with
    // is not written anywhere inside its body text.
    if (destEl.hasAttribute('data-mindmap') && srcEl.hasAttribute('data-mindmap')) {
      if (destEl.getAttribute('data-mindmap') === srcEl.getAttribute('data-mindmap') &&
        destEl.getAttribute('data-mindmap-theme') === srcEl.getAttribute('data-mindmap-theme') &&
        destEl.classList.contains('is-ready')) {
        if (destEl.dataset.line !== srcEl.dataset.line) destEl.dataset.line = srcEl.dataset.line
        return
      }
    }

    // The scene no longer rides in the attribute (P-01 family), so the two blocks' fence bodies are
    // what say whether the drawing changed: the staged one resolves against this pass's set, the live
    // one against the set registered when it was mounted, and a canvas is not in `innerHTML` either.
    if (destEl.hasAttribute('data-excalidraw') && srcEl.hasAttribute('data-excalidraw')) {
      const destIndex = Number.parseInt(destEl.getAttribute('data-excalidraw-index') ?? '', 10)
      const srcIndex = Number.parseInt(srcEl.getAttribute('data-excalidraw-index') ?? '', 10)
      if (Number.isInteger(destIndex) && destIndex === srcIndex &&
        fenceBody(destEl, 'excalidraw', destIndex) === fenceBody(srcEl, 'excalidraw', srcIndex) &&
        destEl.classList.contains('is-ready')) {
        if (destEl.dataset.line !== srcEl.dataset.line) destEl.dataset.line = srcEl.dataset.line
        return
      }
    }

    const srcAttrs = srcEl.attributes
    const destAttrs = destEl.attributes

    for (let i = destAttrs.length - 1; i >= 0; i--) {
      const attr = destAttrs[i]!
      if (!srcEl.hasAttribute(attr.name)) {
        destEl.removeAttribute(attr.name)
      }
    }
    for (let i = 0; i < srcAttrs.length; i++) {
      const attr = srcAttrs[i]!
      if (destEl.getAttribute(attr.name) !== attr.value) {
        destEl.setAttribute(attr.name, attr.value)
      }
    }

    patchChildren(destEl, srcEl)
  }
}
