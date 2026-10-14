import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A `:focus-visible` outline is only worth having until something takes it away.
 * `outline: none` appears in the stylesheets for two legitimate reasons — a rule
 * that immediately substitutes a token ring, and a third-party surface whose own
 * theme already owns the focus state — and one illegitimate one: a control whose
 * keyboard focus simply stops being visible. This gate fails on the third, because
 * the deletion is invisible in review and only shows up for a keyboard user.
 *
 * It reads the declarations, not a painted page, so it is a floor rather than a
 * proof: it cannot tell a visible 3px ring from an invisible one.
 */
const STYLES_DIR = 'src/client/styles'
const RING_TOKENS = ['--shadow-ring', '--shadow-ring-focus']

type Rule = { file: string; selector: string; body: string }

/** Depth-aware scan, so rules nested in `@media` are judged like top-level ones. */
function collectRules(file: string, css: string): Rule[] {
  const rules: Rule[] = []
  const stack: string[] = []
  let buffer = ''
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      index = end === -1 ? css.length : end + 1
      continue
    }
    if (char === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '))
      buffer = ''
      continue
    }
    if (char === '}') {
      const selector = stack.pop() ?? ''
      const body = buffer.trim()
      // At-rules are containers here; their own bodies are the nested rules.
      if (selector && !selector.startsWith('@')) rules.push({ file, selector, body })
      buffer = ''
      continue
    }
    buffer += char
  }
  return rules
}

// Surfaces this gate does not judge, each with the reason it is exempt. A new
// entry has to carry a reason that survives reading.
const EXEMPT = new Map<string, string>([
  // CodeMirror's own base theme resets the outline on `.cm-focused`, and the editor
  // is a text surface whose caret is its focus signal; the app rule mirrors it.
  ['.ink-editor .cm-editor.cm-focused', 'CodeMirror base theme owns .cm-focused; caret is the signal'],
  // A syntax marker over a bracket pair, never a focusable control.
  ['.ink-editor .cm-matchingBracket, .ink-editor .cm-nonmatchingBracket', 'bracket-pair marker, not a control'],
  // The Excalidraw override block re-states the library's own resets to win against
  // injected styles; the audit kept it as legitimate !important territory.
  ['.excalidraw .sidebar .ExcTextField__input input, .excalidraw .layer-ui__wrapper', 'Excalidraw override block'],
])

const isExempt = (rule: Rule) => [...EXEMPT.keys()].some((selector) => selector.split(',')[0]!.trim() === rule.selector.split(',')[0]!.trim())

function declaresRing(body: string) {
  if (RING_TOKENS.some((token) => new RegExp(`box-shadow:[^;]*var\\(${token}\\)`).test(body))) return true
  // An inset spread ring is the same signal drawn inside the box, which is what a
  // canvas needs (`--shadow-ring` has no inset form). It still has to be built from
  // an accent token, not from a bare colour.
  if (/box-shadow:[^;]*inset 0 0 0 \d+px var\(--accent/.test(body)) return true
  // A real outline (not `none`/`0`) is its own visible signal.
  return [...body.matchAll(/outline:\s*([^;]+)/g)].some((match) => !/^none|^0(\s|;|$)/.test(match[1]!.trim()))
}

describe('every suppressed outline is replaced by a visible focus signal', () => {
  const files = fs.readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css'))
  const rules = files.flatMap((name) => collectRules(name, fs.readFileSync(path.join(STYLES_DIR, name), 'utf8')))

  it('scans the whole stylesheet set', () => {
    // Without this, a parser that silently returned nothing would make the gate pass.
    expect(files.length).toBeGreaterThanOrEqual(10)
    expect(rules.length).toBeGreaterThan(400)
    expect(rules.filter((rule) => /outline:\s*none/.test(rule.body)).length).toBeGreaterThan(10)
  })

  it('gives every outline:none control a ring, an outline, or a stated exemption', () => {
    const stripped = rules.filter((rule) => /outline:\s*none/.test(rule.body) && !isExempt(rule))
    const orphans = stripped.filter((rule) => {
      if (declaresRing(rule.body)) return false
      // The same control may carry its signal in a sibling rule, e.g. a
      // `:focus-visible` companion that adds the ring on top of the base reset.
      const bases = rule.selector.split(',').map((part) => part.replace(/:focus(-visible)?/g, '').trim())
      return !rules.some((other) => other !== rule && /:focus(-visible)?/.test(other.selector)
        && bases.some((base) => other.selector.split(',').some((part) => part.replace(/:focus(-visible)?/g, '').trim() === base))
        && declaresRing(other.body))
    })
    expect(orphans, `invisible keyboard focus at ${JSON.stringify(orphans.map((rule) => `${rule.file}: ${rule.selector}`))}`).toEqual([])
  })

  it('still ships focus rings built from the ring tokens, not hand-spelled spreads', () => {
    // 铁律 4: the ring geometry is a token. A re-spelled `0 0 0 3px var(--accent-ring)`
    // would be the same pixels today and a divergence tomorrow.
    const handSpelled = rules.filter((rule) => /box-shadow:[^;]*0 0 0 [23]px var\(--accent-ring\)/.test(rule.body))
    expect(handSpelled.map((rule) => `${rule.file}: ${rule.selector}`)).toEqual([])
  })
})

describe('compact prose controls clear the touch floor on coarse pointers', () => {
  const prose = fs.readFileSync(path.join(STYLES_DIR, 'prose.css'), 'utf8')

  it('widen the chip row and the JSON filter for a thumb', () => {
    // Each of these is a cursor-sized control; the coarse-pointer block is what
    // makes them tappable without changing the desktop density.
    for (const selector of ['.ink-prose .block-opt-btn', '.ink-prose .json-filter-input']) {
      const block = [...prose.matchAll(/@media \(pointer: coarse\) \{([^{}]*\{[^{}]*\}[^{}]*)\}/g)]
        .map((match) => match[1])
        .find((body) => body.includes(selector))
      expect(block, `no @media (pointer: coarse) rule for ${selector}`).toBeDefined()
      expect(block!).toMatch(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*var\\(--tap-target\\)`))
    }
  })

  it('keeps the tap floor a named constant rather than a magic 44', () => {
    const tokens = fs.readFileSync(path.join(STYLES_DIR, 'tokens.css'), 'utf8')
    expect(tokens).toMatch(/--tap-target:\s*44px/)
  })
})
