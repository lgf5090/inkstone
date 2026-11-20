// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderElement } from '../src/client/lib/test-render'
import { Menu } from '../src/client/components/overlay'

function renderMenu(items: Parameters<typeof Menu>[0]['items']) {
  return renderElement(
    <Menu anchor={{ x: 0, y: 0 }} open onClose={() => undefined} label="contract" items={items} />,
  )
}

describe('menu rows with an address', () => {
  it('renders an external row as a real link so the browser owns the navigation', () => {
    const rendered = renderMenu([{ id: 'open', label: 'Open on GitHub', href: 'https://github.com/acme/repo' }])
    const link = document.body.querySelector('a[role="menuitem"]')
    expect(link?.getAttribute('href')).toBe('https://github.com/acme/repo')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(document.body.querySelector('button[role="menuitem"]')).toBeNull()
    rendered.unmount()
  })

  it('keeps a row without an address a button and marks a disabled link', () => {
    const rendered = renderMenu([
      { id: 'copy', label: 'Copy', onSelect: () => undefined },
      { id: 'download', label: 'Download', href: 'https://example.com/a.zip', disabled: true },
    ])
    expect(document.body.querySelector('button[role="menuitem"]')?.textContent).toContain('Copy')
    const disabled = document.body.querySelector('a[role="menuitem"]')
    expect(disabled?.getAttribute('aria-disabled')).toBe('true')
    expect(disabled?.getAttribute('href')).toBe('https://example.com/a.zip')
    rendered.unmount()
  })
})
