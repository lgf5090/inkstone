import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadEmojiUnicode } from '../emoji-unicode'
import { renderMarkdown, renderMarkdownBlocks } from './renderer'

const SMILE = '😄'
const ROCKET = '🚀'

beforeAll(async () => {
  await loadEmojiUnicode()
})

const html = (source: string, options?: { emojiShortcodes?: boolean }) => renderMarkdown(source, options).html

describe('emoji shortcodes in the renderer', () => {
  it('turns a code into the glyph it names', () => {
    expect(html('ship it :rocket: today')).toContain(`${ROCKET} today`)
    expect(html(':smile:')).toContain(SMILE)
  })

  it('reads the underscore spelling and an alias, but only the whole word', () => {
    expect(html(':star_struck:')).toContain('🤩')
    expect(html(':satisfied:')).toContain('😆')
    expect(html(':not_a_real_code_at_all:')).toContain(':not_a_real_code_at_all:')
  })

  it('leaves a clock and a ratio alone', () => {
    expect(html('starts at 12:30:00')).toContain('12:30:00')
    expect(html('ratio 1:100:1')).toContain('1:100:1')
    expect(html('score 5:3')).toContain('score 5:3')
    expect(html('a hundred percent :100:')).toContain('💯')
  })

  it('never reaches into code, fenced or inline', () => {
    const fenced = html('```\n:rocket:\n```')
    expect(fenced).toContain(':rocket:')
    expect(fenced).not.toContain(ROCKET)
    const inline = html('use `:rocket:` to name it')
    expect(inline).toContain(':rocket:')
    expect(inline).not.toContain(ROCKET)
  })

  it('keeps the container syntax out of it', () => {
    const rendered = html(':::details Title\nhidden\n:::\n')
    expect(rendered).toContain('<details')
    expect(rendered).toContain('hidden')
    expect(rendered).not.toContain(':::')
    // A `:::` run that opens nothing is still a `:::` run, and its colons are not a code's colons.
    expect(html(':::smile:\nbody\n:::\n')).toContain(':smile:')
  })

  it('takes an escape', () => {
    expect(html('\\:rocket: stays words')).toContain(':rocket:')
    expect(html('\\:rocket: stays words')).not.toContain(ROCKET)
  })

  it('leaves a link target alone, since it is not prose', () => {
    const rendered = html('[launch](https://example.test/:rocket:/)')
    expect(rendered).toContain('https://example.test/:rocket:/')
    expect(rendered).not.toContain(ROCKET)
  })

  it('works where a line is not a paragraph', () => {
    expect(html('# Ship :rocket:')).toContain(ROCKET)
    expect(html('| a | b |\n| - | - |\n| :rocket: | ok |')).toContain(ROCKET)
    expect(html('- [ ] ship :rocket:')).toContain(ROCKET)
  })

  it('renders two codes in a row without eating the space between them', () => {
    expect(html(':rocket::smile:')).toContain(`${ROCKET}${SMILE}`)
    expect(html('(:rocket:)')).toContain(`(${ROCKET})`)
    const label = html(`${String.fromCodePoint(0x53d1, 0x5e03)}:rocket:`)
    expect(label).not.toContain(ROCKET)
  })

  it('follows the switch', () => {
    expect(html(':rocket:', { emojiShortcodes: false })).toContain(':rocket:')
    expect(html(':rocket:', { emojiShortcodes: false })).not.toContain(ROCKET)
  })

  it('is the same answer for the live-preview block pass', () => {
    const blocks = renderMarkdownBlocks('ship :rocket:\n')
    expect(blocks.blocks.some((block) => block.html.includes(ROCKET))).toBe(true)
    const off = renderMarkdownBlocks('ship :rocket:\n', { emojiShortcodes: false })
    expect(off.blocks.some((block) => block.html.includes(ROCKET))).toBe(false)
  })
})

describe('the set is a lazy chunk', () => {
  it('renders the literal text first and asks for the set, then substitutes once it is here', async () => {
    vi.resetModules()
    const fresh = await import('./renderer')
    const unicode = await import('../emoji-unicode')
    expect(unicode.emojiUnicodeIsLoaded()).toBe(false)
    expect(fresh.renderMarkdown('ship :rocket:').html).toContain(':rocket:')
    await unicode.loadEmojiUnicode()
    expect(fresh.renderMarkdown('ship :rocket:').html).toContain('🚀')
    vi.resetModules()
  })
})
