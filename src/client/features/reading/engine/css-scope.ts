/**
 * Making a book's stylesheet safe to put on the same page as the app.
 *
 * The CSP this app serves forbids `frame-src`, so an EPUB cannot be rendered in an iframe the way
 * most web readers do. The alternative is to render the chapter in the document and quarantine its
 * CSS by prefixing every selector with the reader's own container — which is what this file does,
 * because a book's `body { position: fixed }` or `* { font-family: serif }` would otherwise reach
 * straight through to the app's chrome.
 *
 * The scanner is hand-written rather than `CSSStyleSheet`-based for two reasons: the reader has to
 * work before a document is in the DOM, and `cssRules` silently drops every rule a browser does not
 * understand, which is exactly the set of rules a book's author cared about.
 */

const BLOCK_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'document'])
const PASSTHROUGH_AT_RULES = new Set(['font-face', 'keyframes', '-webkit-keyframes', '-moz-keyframes', 'viewport', 'counter-style', 'property', 'page'])

export interface CssScopeOptions {
  /** The selector every rule is confined to. */
  scope: string
  /** Rewrite a relative reference (an image or font) into something loadable. */
  resolveUrl: (url: string) => string
  /** Fetch an `@import` target's own text, relative to the sheet being scoped. */
  resolveImport?: (url: string) => string | null | Promise<string | null>
}

function stripComments(css: string): string {
  let out = ''
  let at = 0
  while (at < css.length) {
    const open = css.indexOf('/*', at)
    if (open < 0) {
      out += css.slice(at)
      break
    }
    const close = css.indexOf('*/', open + 2)
    out += css.slice(at, open)
    at = close < 0 ? css.length : close + 2
  }
  return out
}

/** Advance past a quoted run starting at `at`, honouring backslash escapes. */
function skipQuoted(css: string, at: number): number {
  const quote = css[at]
  let cursor = at + 1
  while (cursor < css.length) {
    if (css[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (css[cursor] === quote) return cursor + 1
    cursor++
  }
  return cursor
}

/** The index of the delimiter that closes this block, skipping over strings and nested blocks. */
function findBlockEnd(css: string, from: number): number {
  let depth = 0
  for (let at = from; at < css.length; at++) {
    const char = css[at]
    if (char === '"' || char === "'") {
      at = skipQuoted(css, at) - 1
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return at
    }
  }
  return css.length
}

function findTopLevel(css: string, from: number, targets: string): number {
  let parens = 0
  for (let at = from; at < css.length; at++) {
    const char = css[at]
    if (char === '"' || char === "'") {
      at = skipQuoted(css, at) - 1
      continue
    }
    if (char === '(' || char === '[') parens++
    else if (char === ')' || char === ']') parens--
    else if (parens === 0 && targets.includes(char)) return at
  }
  return -1
}

/** Split a selector list on its commas, leaving the commas inside `:is(a,b)` alone. */
function splitSelectors(list: string): string[] {
  const out: string[] = []
  let current = ''
  let parens = 0
  for (let at = 0; at < list.length; at++) {
    const char = list[at]
    if (char === '"' || char === "'") {
      const end = skipQuoted(list, at)
      current += list.slice(at, end)
      at = end - 1
      continue
    }
    if (char === '(' || char === '[') parens++
    else if (char === ')' || char === ']') parens--
    if (char === ',' && parens === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += char
  }
  out.push(current)
  return out.map((part) => part.trim()).filter(Boolean)
}

const ROOT_TOKENS = ['html', 'body', ':root', ':host']
const ROOT_RUN = new RegExp(`^(?:${ROOT_TOKENS.join('|')})((?:[.:#][\\w-]+|\\[[^\\]]*\\])*)`, 'i')

/**
 * Confine one selector to the reader container. A rule written against the document itself (`html`,
 * `body`, `:root`, or any chain of them) describes the page the author had, which in this app is the
 * container the chapter is laid out in.
 */
export function prefixSelector(selector: string, scope: string): string {
  let rest = selector.trim()
  if (!rest) return ''
  if (rest.startsWith(scope)) return rest
  if (rest === '*') return `${scope} *`
  let attached = ''
  for (;;) {
    const match = ROOT_RUN.exec(rest)
    if (!match) break
    const tail = rest.slice(match[0].length)
    // `bodytext` is not `body` followed by a qualifier: only a separator ends the document chain.
    if (tail && !/^[\s>+~]/.test(tail)) break
    attached += match[1]
    // `html > body > p` describes the document, so its first combinator is not the reader's.
    rest = tail.replace(/^[>+~\s]+/, '')
    if (!rest || rest === '*') return `${scope}${attached}`
  }
  return `${scope}${attached} ${rest}`
}

export function rewriteUrls(css: string, resolve: (url: string) => string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, (whole, quote: string, raw: string) => {
    if (!raw || /^(data|https?|blob):/i.test(raw)) return whole
    const next = resolve(raw)
    return `url(${quote || '"'}${next}${quote || '"'})`
  })
}

async function scopeStatement(css: string, options: CssScopeOptions, base: string): Promise<string> {
  const at = css.indexOf('@')
  if (at !== 0) return scopeRule(css, options, base)
  const nameMatch = /^@([\w-]+)/.exec(css)
  if (!nameMatch) return ''
  const name = nameMatch[1].toLowerCase()
  const boundary = findTopLevel(css, at + nameMatch[0].length, '{;')
  if (boundary < 0) return ''
  const prelude = css.slice(at + nameMatch[0].length, boundary).trim()

  if (css[boundary] === ';') {
    if (name === 'import' && options.resolveImport) {
      const raw = importTarget(prelude)
      const joined = raw ? joinCssPath(dirOfCss(base), raw) : ''
      const imported = raw ? await options.resolveImport(joined) : null
      if (imported) return await scopeCss(imported, options, joined)
    }
    return ''
  }

  const end = findBlockEnd(css, boundary)
  const body = css.slice(boundary + 1, end)
  if (BLOCK_AT_RULES.has(name)) {
    return `@${name} ${prelude}{${await scopeCss(body, options, base)}}`
  }
  if (name === 'font-face') {
    return `@font-face{${rewriteDeclarations(body, options, base)}}`
  }
  if (name === 'keyframes' || name.startsWith('-')) {
    return PASSTHROUGH_AT_RULES.has(name) && name !== 'page'
      ? `@${name} ${prelude}{${rewriteUrls(body.trim(), (url) => options.resolveUrl(joinCssPath(dirOfCss(base), url)))}}`
      : ''
  }
  return ''
}

function scopeRule(css: string, options: CssScopeOptions, base: string): string {
  const boundary = findTopLevel(css, 0, '{;')
  if (boundary < 0 || css[boundary] === ';') return ''
  const end = findBlockEnd(css, boundary)
  const selectors = splitSelectors(css.slice(0, boundary)).map((one) => prefixSelector(one, options.scope))
    .filter(Boolean)
  if (!selectors.length) return ''
  return `${selectors.join(',')}{${rewriteDeclarations(css.slice(boundary + 1, end), options, base)}}`
}

/** Every relative reference is handed to the resolver already joined, whichever rule held it. */
function rewriteDeclarations(body: string, options: CssScopeOptions, base: string): string {
  return rewriteUrls(body.trim(), (url) => options.resolveUrl(joinCssPath(dirOfCss(base), url)))
}

/** The sheet an `@import` names, with its `url()` wrapper and any media list taken off. */
function importTarget(prelude: string): string | null {
  const first = prelude.trim().split(/\s+/)[0] ?? ''
  const bare = first.replace(/^url\(\s*/i, '').replace(/\s*\)/, '')
  const unquoted = bare.replace(/^['"]/, '').replace(/['"]$/, '')
  return unquoted || null
}

function dirOfCss(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/** Join a stylesheet's own directory with a relative `url()` or `@import` target. */
export function joinCssPath(baseDir: string, target: string): string {
  const clean = target.split('#')[0]
  if (clean.startsWith('/') || /^[a-z]+:/i.test(clean)) return clean
  const segments = `${baseDir}/${clean}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  try {
    return decodeURIComponent(out.join('/'))
  } catch {
    return out.join('/')
  }
}

/** Rewrite a sheet so it can only affect the reader, resolving its relative references as it goes. */
export function scopeCss(css: string, options: CssScopeOptions, base = ''): Promise<string> {
  return scopeAll(stripComments(css), options, base)
}

async function scopeAll(css: string, options: CssScopeOptions, base: string): Promise<string> {
  const statements: string[] = []
  let at = 0
  while (at < css.length) {
    while (at < css.length && /[\s;]/.test(css[at])) at++
    if (at >= css.length) break
    let end: number
    if (css[at] === '@') {
      const boundary = findTopLevel(css, at, '{;')
      if (boundary < 0) break
      end = css[boundary] === ';' ? boundary + 1 : findBlockEnd(css, boundary) + 1
    } else {
      const boundary = findTopLevel(css, at, '{')
      if (boundary < 0) break
      end = findBlockEnd(css, boundary) + 1
    }
    const statement = css.slice(at, end)
    statements.push(statement)
    at = Math.max(at + 1, end)
  }
  const scoped = await Promise.all(statements.map((statement) => scopeStatement(statement.trim(), options, base)))
  return scoped.join('\n').trim()
}
