// Reads the token layer as declared text rather than as painted pixels, for the
// gates that have to judge colours before anything renders them (see
// tests/kanban-tag-contrast.test.ts and tests/kanban-chart-tokens.test.ts).
// A theme is the cascade the browser would apply: the base `:root` block, then
// the theme block, then that theme's white-background override.

export const TOKENS_PATH = 'src/client/styles/tokens.css'

const THEME_SELECTORS = {
  light: [':root', ":root[data-theme='light']", ":root[data-theme='light'][data-background='white']"],
  dark: [':root', ":root[data-theme='dark']", ":root[data-theme='dark'][data-background='white']"],
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A selector is matched as one item of a selector list, not as a whole line: the theme blocks also
// answer to a bare `[data-code-theme='dark']` (a code block pinning a palette), so `:root[…]` is now
// the first of several selectors sharing one declaration block.
function selectorPattern(selector, flags = '') {
  const name = selector.replace(/\s*\{$/, '')
  return new RegExp(`(?:^|[\\s,])${escapeRegExp(name)}(?=\\s*[,{])`, flags)
}

function hasSelector(source, selector) {
  return selectorPattern(selector).test(source)
}

function declarations(source, selector) {
  const map = new Map()
  // The same selector may appear in several blocks (`:root` is not one block),
  // and the cascade keeps whichever came last.
  for (const match of source.matchAll(selectorPattern(selector, 'g'))) {
    const block = source.slice(match.index, source.indexOf('}', match.index))
    for (const entry of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(entry[1], entry[2].trim())
  }
  return map
}

export function themeVars(theme, source) {
  const selectors = THEME_SELECTORS[theme]
  if (!selectors) throw new Error(`unknown theme ${theme}`)
  for (const selector of selectors) if (!hasSelector(source, selector)) throw new Error(`missing ${selector}`)
  return selectors.reduce((acc, selector) => {
    for (const [name, value] of declarations(source, selector)) acc.set(name, value)
    return acc
  }, new Map())
}

// The accent is a choice the user makes, so text drawn on it has to hold for
// every one the stylesheet offers, not just the default.
export function accentNames(source) {
  return [...new Set([...source.matchAll(/\[data-accent='([\w-]+)'\]/g)].map((match) => match[1]))]
}

export function accentVars(theme, accent, source) {
  const selector = `:root[data-accent='${accent}'][data-theme='${theme}'] {`
  if (!source.includes(selector)) throw new Error(`missing ${selector}`)
  // Two attribute selectors beat the plain `:root` default that follows them.
  return new Map([...themeVars(theme, source), ...declarations(source, selector)])
}
