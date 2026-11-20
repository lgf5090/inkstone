// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { attachReadmeImageFallback } from '../src/client/features/development/github/lib/readme-images'

describe('GitHub README image fallback', () => {
  it('retries through the proxy once and then offers the original address', () => {
    const root = document.createElement('div')
    root.innerHTML = '<img src="https://cdn.example.com/a.png" alt="Shot">'
    const detach = attachReadmeImageFallback(root, 'open original')
    const image = root.querySelector('img')!

    image.dispatchEvent(new Event('error'))
    expect(image.getAttribute('src')).toContain('/api/development/github/image?url=')

    image.dispatchEvent(new Event('error'))
    expect(root.querySelector('img')).toBeNull()
    const link = root.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://cdn.example.com/a.png')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link?.textContent).toContain('Shot')
    expect(link?.textContent).toContain('open original')
    detach()
  })

  it('skips the proxy for data images and stops listening after cleanup', () => {
    const root = document.createElement('div')
    root.innerHTML = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Pixel">'
    const detach = attachReadmeImageFallback(root, 'open original')
    const image = root.querySelector('img')!
    image.dispatchEvent(new Event('error'))
    expect(root.querySelector('span')?.className).toBe('github-readme-image-fallback')
    detach()

    const next = document.createElement('div')
    next.innerHTML = '<img src="https://cdn.example.com/b.png" alt="Other">'
    attachReadmeImageFallback(next, 'open original')()
    const other = next.querySelector('img')!
    other.dispatchEvent(new Event('error'))
    expect(other.getAttribute('src')).toBe('https://cdn.example.com/b.png')
  })
})
