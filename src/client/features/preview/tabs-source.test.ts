import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderMarkdown } from '../../lib/markdown/renderer'
import {
  addTabToSource,
  deleteTabInSource,
  getTabsTabCount,
  locateTabsStructure,
  renameTabInSource,
  updateTabsSourceHeader,
} from './tabs-source'

beforeAll(async () => {
  await initI18n()
})

function tabTitles(source: string): string[] {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(source).html
  return [...host.querySelectorAll<HTMLElement>('.markdown-tabs > .tab-list [data-tab-button]')].map((button) => button.textContent ?? '')
}

function panelTexts(source: string): string[] {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(source).html
  return [...host.querySelectorAll<HTMLElement>(':scope .markdown-tabs > [data-tab-panel]')].map((panel) => panel.textContent?.trim() ?? '')
}

const DIRECTIVE = ':::: tabs\n::: tab-item One\na\n:::\n::: tab-item Two\nb\n:::\n::::'
const AT = ':::: tabs\n@tab One\na\n@tab Two\nb\n::::'
const COLON = ':::: tabs\n:: One\na\n:: Two\nb\n::::'
const BARE_COLON = ':::: tabs\na\n::\nb\n::::'

describe('reading a tab block’s shape', () => {
  it('counts the panels each spelling carries', () => {
    expect(getTabsTabCount(DIRECTIVE, 0)).toBe(2)
    expect(getTabsTabCount(AT, 0)).toBe(2)
    expect(getTabsTabCount(COLON, 0)).toBe(2)
    expect(getTabsTabCount(BARE_COLON, 0)).toBe(2)
  })

  it('names the spelling it found', () => {
    expect(locateTabsStructure(DIRECTIVE, 0)?.kind).toBe('directive')
    expect(locateTabsStructure(AT, 0)?.kind).toBe('at')
    expect(locateTabsStructure(COLON, 0)?.kind).toBe('colon')
    expect(locateTabsStructure(BARE_COLON, 0)?.kind).toBe('colon')
  })

  it('reads the header with no space after the colons', () => {
    expect(locateTabsStructure('::::tabs\n@tab One\na\n::::', 0)?.kind).toBe('at')
    expect(locateTabsStructure(':::: {tab-set}\n::: tab-item One\na\n:::\n::::', 0)?.kind).toBe('directive')
  })

  it('leaves the markers of a nested container to that container', () => {
    const source = ':::: tabs\n@tab One\n::: cols\nx\n::\ny\n:::\n@tab Two\nb\n::::'
    expect(getTabsTabCount(source, 0)).toBe(2)
  })

  it('refuses a block the note never closed', () => {
    expect(getTabsTabCount(':::: tabs\n@tab One\na\n', 0)).toBeNull()
    expect(getTabsTabCount('# just prose', 0)).toBeNull()
  })
})

describe('adding a tab', () => {
  it('numbers the new tab after the ones the block already has', () => {
    expect(addTabToSource(DIRECTIVE, 0)).toContain('::: tab-item Tabs 3')
    expect(addTabToSource(AT, 0)).toContain('@tab Tabs 3')
    expect(addTabToSource(COLON, 0)).toContain(':: Tabs 3')
  })

  it('writes the spelling the block already uses, so the existing panels survive', () => {
    const next = addTabToSource(BARE_COLON, 0)!
    expect(next).toContain(':: Tabs')
    expect(next).not.toContain('@tab')
    expect(panelTexts(next)).toEqual(['a', 'b', ''])
    expect(tabTitles(next)).toEqual(['Tabs', 'Tabs', 'Tabs 3'])
  })

  it('keeps every panel of a titled colon block when it appends', () => {
    const next = addTabToSource(COLON, 0)!
    expect(panelTexts(next)).toEqual(['a', 'b', ''])
  })

  it('closes the item it opens', () => {
    const next = addTabToSource(DIRECTIVE, 0)!
    expect(next.trimEnd().endsWith('::::')).toBe(true)
    expect(tabTitles(next)).toEqual(['One', 'Two', 'Tabs 3'])
  })

  it('takes a title it is given', () => {
    expect(addTabToSource(AT, 0, 'Third')).toBe(':::: tabs\n@tab One\na\n@tab Two\nb\n@tab Third\n\n::::')
  })
})

describe('renaming a tab', () => {
  it('keeps each spelling’s own marker', () => {
    expect(renameTabInSource(DIRECTIVE, 0, 1, 'Second')).toBe(':::: tabs\n::: tab-item One\na\n:::\n::: tab-item Second\nb\n:::\n::::')
    expect(renameTabInSource(AT, 0, 0, 'First')).toBe(':::: tabs\n@tab First\na\n@tab Two\nb\n::::')
    expect(renameTabInSource(COLON, 0, 1, 'Second')).toBe(':::: tabs\n:: One\na\n:: Second\nb\n::::')
  })

  it('keeps the active marker a rename did not touch', () => {
    expect(renameTabInSource(':::: tabs\n@tab:active One\na\n@tab Two\nb\n::::', 0, 0, 'First')).toBe(':::: tabs\n@tab:active First\na\n@tab Two\nb\n::::')
  })

  it('refuses an empty title and an index the block does not have', () => {
    expect(renameTabInSource(AT, 0, 0, '   ')).toBeNull()
    expect(renameTabInSource(AT, 0, 9, 'Nope')).toBeNull()
  })
})

describe('deleting a tab', () => {
  it('takes the item’s own closer with it', () => {
    const next = deleteTabInSource(DIRECTIVE, 0, 0)!
    expect(next).toBe(':::: tabs\n::: tab-item Two\nb\n:::\n::::')
    expect(tabTitles(next)).toEqual(['Two'])
  })

  it('takes the segment up to the next marker for the other spellings', () => {
    expect(tabTitles(deleteTabInSource(AT, 0, 0)!)).toEqual(['Two'])
    expect(tabTitles(deleteTabInSource(COLON, 0, 1)!)).toEqual(['One'])
    expect(panelTexts(deleteTabInSource(COLON, 0, 1)!)).toEqual(['a'])
  })

  it('keeps the last panel standing', () => {
    expect(deleteTabInSource(':::: tabs\n@tab One\na\n::::', 0, 0)).toBeNull()
  })
})

describe('rewriting a tab block’s header options', () => {
  it('writes each option in its canonical form', () => {
    expect(updateTabsSourceHeader(AT, 0, () => ({ variant: 'pills' }))).toBe(':::: tabs variant=pills\n@tab One\na\n@tab Two\nb\n::::')
    expect(updateTabsSourceHeader(':::: tabs\n@tab One\na\n::::', 0, () => ({ align: 'stretch' }))).toBe(':::: tabs align=stretch\n@tab One\na\n::::')
  })

  it('lets position supersede a legacy orientation token', () => {
    const vertical = ':::: tabs style=vertical\n@tab One\na\n::::'
    expect(updateTabsSourceHeader(vertical, 0, () => ({ position: 'right' }))).toBe(':::: tabs position=right\n@tab One\na\n::::')
    expect(updateTabsSourceHeader(vertical, 0, () => ({ position: 'top' }))).toBe(':::: tabs position=top\n@tab One\na\n::::')
  })

  it('keeps tokens the toolbar does not own', () => {
    expect(updateTabsSourceHeader(':::: tabs .wide\n@tab One\na\n::::', 0, () => ({ variant: 'cards' }))).toBe(':::: tabs .wide variant=cards\n@tab One\na\n::::')
  })

  it('writes a sync id back verbatim, since it is case-sensitive', () => {
    expect(updateTabsSourceHeader(AT, 0, () => ({ sync: 'Lang-2' }))).toBe(':::: tabs sync=Lang-2\n@tab One\na\n@tab Two\nb\n::::')
  })

  it('clears an option back to its default', () => {
    expect(updateTabsSourceHeader(':::: tabs variant=pills\n@tab One\na\n::::', 0, () => ({ variant: 'default' }))).toBe(':::: tabs\n@tab One\na\n::::')
  })
})

describe('a note that uses CRLF line endings', () => {
  it('does not turn the document into mixed endings', () => {
    const crlf = AT.replace(/\n/g, '\r\n')
    const next = addTabToSource(crlf, 0, 'Three')!
    expect(next.split('\n').slice(0, -1).every((line) => line.endsWith('\r'))).toBe(true)
    expect(next.replace(/\r\n/g, '\n')).toBe(addTabToSource(AT, 0, 'Three'))
  })
})
