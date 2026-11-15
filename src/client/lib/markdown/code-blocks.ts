import { highlightWithPrism } from './prism'

export interface CodeBlockLabels {
  copy: string
  plainText: string
}

export function decorateCodeBlocks(root: HTMLElement, labels: CodeBlockLabels): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const code = pre.querySelector('code')
    const language = /language-([\w-]+)/.exec(code?.className ?? '')?.[1] ?? ''

    if (!pre.parentElement?.classList.contains('gh-code')) {
      const wrapper = document.createElement('div')
      wrapper.className = 'gh-code'
      pre.replaceWith(wrapper)

      const head = document.createElement('div')
      head.className = 'gh-code-head'

      const label = document.createElement('span')
      label.className = 'gh-code-lang'
      label.textContent = language || labels.plainText

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'gh-code-copy'
      button.dataset.copyCode = ''
      button.textContent = labels.copy
      button.setAttribute('aria-label', labels.copy)

      head.append(label, button)
      wrapper.append(head, pre)
    }

    if (!language || !code || code.querySelector('.token')) continue
    void highlightWithPrism(code.textContent ?? '', language)
      .then((result) => {
        if (result && root.isConnected) code.innerHTML = result.html
      })
      .catch((error: unknown) => {
        console.warn('[inkstone] README highlighting failed:', error)
      })
  }
}
