import { proxiedImageUrl } from './image'

const PROXY_PREFIX = '/api/development/github/image?'

export function attachReadmeImageFallback(root: HTMLElement, label: string): () => void {
  const onError = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLImageElement) || !root.contains(target)) return
    const current = target.getAttribute('src') ?? ''
    const original = target.dataset.originalSrc ?? current
    if (!target.dataset.imageFallback && original && !original.startsWith(PROXY_PREFIX) && !original.startsWith('data:')) {
      target.dataset.imageFallback = 'proxy'
      target.dataset.originalSrc = original
      target.src = proxiedImageUrl(original)
      return
    }
    const external = /^https?:\/\//i.test(original) ? original : ''
    const node = external ? document.createElement('a') : document.createElement('span')
    if (external) {
      node.setAttribute('href', external)
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
      node.setAttribute('title', external)
    }
    node.className = 'github-readme-image-fallback'
    const alt = target.getAttribute('alt')?.trim()
    node.textContent = alt ? `${alt} · ${label}` : label
    target.replaceWith(node)
  }
  root.addEventListener('error', onError, true)
  return () => root.removeEventListener('error', onError, true)
}
