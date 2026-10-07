import { describe, expect, it } from 'vitest'
import { containerRangeInText, headingLevelOf, isSafeExternalUrl, setHeadingLevelInText, taskToBullet, taskToBulletInText } from './line-edits'

describe('isSafeExternalUrl', () => {
  it('allows the schemes a note actually links to', () => {
    for (const url of ['https://example.test/a', 'http://a.test', 'mailto:me@a.test', 'tel:+1234', '#section', '/notes/a', './rel', '../up']) {
      expect(isSafeExternalUrl(url)).toBe(true)
    }
  })

  it('refuses a script-bearing scheme read straight out of the note', () => {
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', '  javascript:history.back()', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd']) {
      expect(isSafeExternalUrl(url)).toBe(false)
    }
  })

  it('refuses an empty target rather than opening the current page', () => {
    expect(isSafeExternalUrl('')).toBe(false)
    expect(isSafeExternalUrl('   ')).toBe(false)
  })
})

describe('heading level edits', () => {
  it('reads the level a line carries', () => {
    expect(headingLevelOf('### Title')).toBe(3)
    expect(headingLevelOf('Title')).toBe(0)
    expect(headingLevelOf('##')).toBe(2)
  })

  it('writes the marker without touching the body', () => {
    expect(setHeadingLevelInText('a\n## Title\nb', 1, 3)).toBe('a\n### Title\nb')
    expect(setHeadingLevelInText('## Title', 0, 0)).toBe('Title')
  })

  it('changes only the marker, never the body it wraps', () => {
    expect(setHeadingLevelInText('## C# and F##', 0, 3)).toBe('### C# and F##')
  })

  it('refuses a line that stopped being a heading', () => {
    expect(setHeadingLevelInText('plain', 0, 2)).toBeNull()
    expect(setHeadingLevelInText('a\nb', 5, 2)).toBeNull()
  })
})

describe('taskToBullet', () => {
  it('strips the checkbox and keeps the marker and indentation', () => {
    expect(taskToBullet('- [x] done')).toBe('- done')
    expect(taskToBullet('  1. [ ] numbered')).toBe('  1. numbered')
    expect(taskToBullet('\t* [X] tabbed')).toBe('\t* tabbed')
  })

  it('refuses a line that is not a task', () => {
    expect(taskToBullet('- plain')).toBeNull()
    expect(taskToBulletInText('plain', 0)).toBeNull()
  })
})

describe('containerRangeInText', () => {
  it('finds the closer the block rules find', () => {
    const source = 'lead\n\n:::: tabs\n@tab A\nx\n::::\n'
    expect(containerRangeInText(source, 2)).toEqual({ start: 2, end: 5 })
  })

  it('reports nothing for a line that does not open a container', () => {
    expect(containerRangeInText('plain\n', 0)).toBeNull()
  })

  it('reports nothing for a container the note never closes', () => {
    expect(containerRangeInText('::: cols\nbody\n', 0)).toBeNull()
  })

  it('does not mistake a colon fence inside a code sample for a container', () => {
    expect(containerRangeInText('::: cols\n```\n::: fake\n```\n:::\n', 0)).toEqual({ start: 0, end: 4 })
    expect(containerRangeInText('```\n::: fake\n```\n', 1)).toBeNull()
  })
})
