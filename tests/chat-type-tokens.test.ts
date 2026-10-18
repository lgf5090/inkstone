// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * One size and one density setting, reaching the two surfaces a reader actually reads.
 *
 * `settings → appearance` already carries a body-text size and an interface density, and both were wired to
 * exactly one surface: the prose styles read `--prose-size`, while `.ink-chat-prose` — the class the
 * assistant's replies and the canvas drafts are drawn with — shipped a literal `var(--text-13)`. A reader
 * who raised their text size for the notebook therefore read the assistant's answers at the old size, and
 * the density switch moved the note list and nothing the reader was reading.
 *
 * The fix has to stay in the token scale to be a fix at all: a rule that reads a pixel is a second setting
 * nobody can find. So the chat takes its size from `--chat-size`, which is `--prose-size` minus a named
 * step, and its leading from `--chat-line`, which the density selector retunes.
 *
 * These read the stylesheet rather than a computed value, because `getComputedStyle` in jsdom hands back the
 * `var()` string — it resolves nothing — and the numbers in the sheet are what the browser is handed.
 */
/**
 * The two sheets, with their line endings settled.
 *
 * A checkout on Windows can hand back CRLF, and every rule below is matched a line at a time, so the
 * endings are normalised here rather than being a reason a green branch turns red on one machine.
 */
const normalise = (source: string): string => source.replaceAll('\r\n', '\n')
const TOKENS = normalise(readFileSync('src/client/styles/tokens.css', 'utf8'))
const CHAT = normalise(readFileSync('src/client/styles/chat.css', 'utf8'))

/** The declarations of the first rule written for `selector`, in declaration order. */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source)
  return match?.[1] ?? ''
}

/** Every `name: value` pair a rule body declares. */
function declarations(body: string): Array<[string, string]> {
  return body
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':')
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()] as [string, string]
    })
}

const property = (body: string, name: string): string =>
  declarations(body).find(([key]) => key === name)?.[1] ?? ''

/**
 * The value a token is given anywhere in the sheet.
 *
 * Read by line rather than by splitting on `;`, because the file's own comments are prose and carry the
 * punctuation a declaration is made of: a name written at the start of a line is a definition, and a name
 * written inside a sentence is not.
 */
function tokenValue(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped}:([^;]*);`, 'm').exec(source)
  return match?.[1]?.trim() ?? ''
}

describe('the chat reads the reader\'s own type setting', () => {
  it('takes its size from the prose size rather than a fixed step', () => {
    const chat = ruleBody(CHAT, '.ink-chat-prose')
    expect(chat, 'the .ink-chat-prose rule is gone').not.toBe('')
    expect(property(chat, 'font-size')).toBe('var(--chat-size)')
    // A literal step is the bug this guards: it is a size the reader cannot change.
    expect(chat).not.toMatch(/font-size:\s*var\(--text-/)
    expect(chat).not.toMatch(/font-size:\s*\d/)
  })

  it('defines the chat step from the one setting the reader moves', () => {
    const size = tokenValue(TOKENS, '--chat-size')
    expect(size, '--chat-size is not defined in the token scale').toContain('calc(')
    expect(size).toContain('var(--prose-size)')
    expect(size).toContain('var(--chat-size-offset)')
    // The offset is its own step: the chat's gap from the prose size is a decision, not a magic number.
    expect(tokenValue(TOKENS, '--chat-size-offset')).toMatch(/^\d+(\.\d+)?px$/)
  })

  it('keeps the leading on its own token so density has something to move', () => {
    const chat = ruleBody(CHAT, '.ink-chat-prose')
    expect(property(chat, 'line-height')).toBe('var(--chat-line)')
    expect(tokenValue(TOKENS, '--chat-line')).toBe('var(--ui-line)')
  })
})

describe('interface density', () => {
  const COMPACT = ':root[data-density=\'compact\']'

  it('has a selector of its own in the token scale', () => {
    expect(TOKENS, 'nothing in the stylesheet answers the density setting').toContain(COMPACT)
    expect(tokenValue(TOKENS, '--chat-line')).not.toBe('')
  })

  it('retunes the chat leading, and nothing that the reader sets by hand', () => {
    const body = ruleBody(TOKENS, COMPACT)
    const pairs = declarations(body)
    expect(pairs.length, 'the density rule declares nothing').toBeGreaterThan(0)
    expect(property(body, '--chat-line')).not.toBe('')
    expect(property(body, '--chat-line')).not.toBe('var(--ui-line)')
    // The size, its leading and the measure are three explicit settings already; density does not
    // silently move them again behind the reader's own choice.
    const offenders = pairs
      .filter(([key]) => /font-size|prose-size|prose-line|prose-width|chat-size/.test(key))
      .map(([key]) => key)
    expect(offenders, 'density double-controls a setting the reader already owns').toEqual([])
  })

  it('changes values without introducing an animation of its own', () => {
    const body = ruleBody(TOKENS, COMPACT)
    expect(body, 'the density rule is gone, so this has nothing to check').not.toBe('')
    const animated = declarations(body).filter(([key]) => /^(transition|animation)/.test(key))
    expect(animated, 'a density switch has to be instant, not eased').toEqual([])
    expect(body).not.toMatch(/\d+m?s/)
    // The scale's own reduced-motion answer, which every eased surface inherits.
    const reduced = ruleBody(TOKENS, '@media (prefers-reduced-motion: reduce) {\n  :root')
    expect(reduced, 'the reduced-motion override is gone').toContain('--dur-fast')
    expect(property(reduced, '--dur-fast')).toBe('1ms')
  })
})
