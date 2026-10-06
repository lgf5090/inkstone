import { findColonClose, deindent, lineIndent, scanSourceBody } from '../../lib/markdown/colon-fence'
import { parseTabsOptions } from '../../lib/markdown/panel-options'
import type { TabsOptions } from '../../lib/markdown/panel-options'
import { joinLines, splitLines } from '../../lib/markdown/fence-edit'
import { t } from '../../lib/i18n'

/**
 * The source edits behind a tab block's settings toolbar.
 *
 * A tab block can be written three ways — `@tab Title`, `::: tab-item Title`, or a `:: Title`
 * separator — and which one a note uses decides what an edit has to write back. Appending the wrong
 * spelling is not a cosmetic mistake: the renderer reads `@tab` before it reads `::`, so adding an
 * `@tab` line to a `::` block collapses every panel the author had already written. So the structure
 * is located once, in the same order the renderer uses, and every edit is written in the spelling the
 * block already carries.
 */

type TabKind = 'at' | 'directive' | 'colon'

interface LocatedTab {
  kind: TabKind
  markerLine: number
  /** Exclusive end of the segment, so a delete takes the marker and its body together. */
  endLine: number
  /** The literal prefix a rename keeps and replaces only the title after. */
  prefix: string
  title: string
}

interface TabsStructure {
  lines: string[]
  eol: string
  trailingNewline: boolean
  indent: string
  markerLength: number
  closeLine: number
  kind: TabKind
  tabs: LocatedTab[]
}

// No word boundary after the active prefix: `+` and `:` are non-word chars, so a boundary never meets
// the following space.
const AT_TAB = /^(@tab(?:(?::active|\+))?)([ \t]+)(.+?)[ \t]*$/
const TAB_ITEM = /^(:{3,})(?:\{tab-item\}|[ \t]+tab-item)(?:[ \t]+(.*?))?[ \t]*$/
const COLON_TAB = /^::(?!:)[ \t]*(.*)$/
// The same two spellings the renderer's `modern_container` claims, including the header written with no
// space after the colons — a toolbar that could not read `:::tabs` could not edit it either.
const TABS_HEADER = /^(:{3,})[ \t]*(tabs|t)\b(?:[ \t]+(.*))?$/i
const TABS_DIRECTIVE_HEADER = /^(:{3,})[ \t]*\{(tab-set)\}[ \t]*(.*)$/i

const MANAGED_OPTION_KEYS = ['style', 'orientation', 'variant', 'align', 'position', 'placement', 'sync', 'group']
const MANAGED_FLAGS = [
  'vertical',
  'horizontal',
  'default',
  'pills',
  'cards',
  'minimal',
  'start',
  'center',
  'end',
  'stretch',
  'left',
  'right',
  'top',
  'bottom',
  'full',
]

function isManagedTabsOption(token: string): boolean {
  const clean = token.replace(/^["']|["']$/g, '').trim().toLowerCase()
  const eqIdx = clean.indexOf('=')
  if (eqIdx !== -1) return MANAGED_OPTION_KEYS.includes(clean.slice(0, eqIdx).trim())
  return MANAGED_FLAGS.includes(clean)
}

/** The line that closes the nested container this entry opens, or the body's own end. */
function nestedClose(scanned: ReturnType<typeof scanSourceBody>, from: number, fallback: number): number {
  for (let index = from + 1; index < scanned.length; index++) {
    const entry = scanned[index]!
    if (entry.depth === 1 && entry.fence && !entry.fence.opens) return entry.line
  }
  return fallback
}

export function locateTabsStructure(source: string, sourceLine: number): TabsStructure | null {
  if (!Number.isInteger(sourceLine) || sourceLine < 0) return null
  const doc = splitLines(source)
  const raw = doc.lines[sourceLine]
  if (raw === undefined) return null
  const head = deindent(raw)
  const header = TABS_HEADER.exec(head) ?? TABS_DIRECTIVE_HEADER.exec(head)
  if (!header) return null
  const markerLength = header[1]!.length
  const closeLine = findColonClose(doc.lines, sourceLine + 1, doc.lines.length, markerLength)
  if (closeLine < 0) return null

  const scanned = scanSourceBody(doc.lines, sourceLine + 1, closeLine)
  const directive: LocatedTab[] = []
  const at: LocatedTab[] = []
  const colon: LocatedTab[] = []
  for (let index = 0; index < scanned.length; index++) {
    const entry = scanned[index]!
    if (entry.depth > 0) continue
    if (entry.fence) {
      const item = TAB_ITEM.exec(entry.text)
      if (item)
        directive.push({ kind: 'directive', markerLine: entry.line, endLine: nestedClose(scanned, index, closeLine) + 1, prefix: `${item[1]!} tab-item `, title: item[2]?.trim() ?? '' })
      continue
    }
    const atTab = AT_TAB.exec(entry.text)
    if (atTab) {
      at.push({ kind: 'at', markerLine: entry.line, endLine: closeLine, prefix: `${atTab[1]}${atTab[2]}`, title: atTab[3]! })
      continue
    }
    const colonTab = COLON_TAB.exec(entry.text)
    if (colonTab)
      colon.push({ kind: 'colon', markerLine: entry.line, endLine: closeLine, prefix: ':: ', title: colonTab[1]!.trim() })
  }

  // The renderer reads `@tab` before it reads `::`, so a note that uses both keeps its `@tab` segments
  // and the stray `::` lines stay content. A `::` is a separator, so what sits above the first one is
  // the first panel — and it carries no marker line of its own, which a rename has to insert.
  const first = colon[0]
  if (first && first.markerLine > sourceLine + 1 && doc.lines.slice(sourceLine + 1, first.markerLine).some((line) => line.trim()))
    colon.unshift({ kind: 'colon', markerLine: sourceLine + 1, endLine: closeLine, prefix: '', title: '' })

  const kind: TabKind = directive.length ? 'directive' : at.length ? 'at' : colon.length ? 'colon' : header[2]!.toLowerCase() === 'tab-set' ? 'directive' : 'colon'
  const found = kind === 'directive' ? directive : kind === 'at' ? at : colon
  // A directive item already ends at its own `:::`, which a delete has to take with it; only the two
  // spellings that carry no closer of their own end where the next marker begins.
  const segments = kind === 'directive' ? found : found.map((tab, tabIndex) => ({ ...tab, endLine: found[tabIndex + 1]?.markerLine ?? closeLine }))
  return {
    ...doc,
    indent: lineIndent(raw),
    markerLength,
    closeLine,
    kind,
    tabs: segments,
  }
}

export function updateTabsSourceHeader(
  source: string,
  sourceLine: number,
  updater: (opts: TabsOptions) => Partial<TabsOptions>,
): string | null {
  const structure = locateTabsStructure(source, sourceLine)
  if (!structure) return null
  const raw = structure.lines[sourceLine]!
  const head = deindent(raw)
  const legacyMatch = TABS_HEADER.exec(head)
  const directiveMatch = TABS_DIRECTIVE_HEADER.exec(head)
  const marker = legacyMatch?.[1] ?? directiveMatch![1]!
  const kind = legacyMatch?.[2] ?? directiveMatch![2]!
  const rawInfo = (legacyMatch?.[3] ?? directiveMatch?.[3] ?? '').trim()
  const currentOpts = parseTabsOptions(rawInfo)
  const nextOpts: TabsOptions = { ...currentOpts, ...updater(currentOpts) }

  // Preserve any unmanaged user tokens (e.g. custom classes, directive arguments)
  const tokens = rawInfo.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const unmanagedTokens = tokens.filter((token) => !isManagedTabsOption(token))

  const managedParts: string[] = []
  // Position is the single layout knob: once an edge is set it fully determines the orientation, so a
  // legacy style token is dropped rather than carried along as a redundant, contradictory setting.
  if (nextOpts.position) {
    managedParts.push(`position=${nextOpts.position}`)
  }
  else if (nextOpts.style === 'vertical') {
    managedParts.push('style=vertical')
  }
  else if (
    (currentOpts.style === 'vertical' && nextOpts.style === 'horizontal')
    || /\b(?:style\s*=\s*["']?horizontal["']?|horizontal\b)/i.test(rawInfo)
  ) {
    managedParts.push('style=horizontal')
  }
  if (nextOpts.variant !== 'default') managedParts.push(`variant=${nextOpts.variant}`)
  if (nextOpts.align !== 'start') managedParts.push(`align=${nextOpts.align}`)
  if (nextOpts.sync) managedParts.push(`sync=${nextOpts.sync}`)

  const allParts = [...unmanagedTokens, ...managedParts]
  // The `t` abbreviation is the author's own spelling; only the option tokens get rewritten.
  const prefix = legacyMatch ? `${marker} ${kind}` : `${marker} {${kind}}`
  structure.lines[sourceLine] = `${structure.indent}${allParts.length ? `${prefix} ${allParts.join(' ')}` : prefix}`
  return joinLines(structure.lines, structure.eol, structure.trailingNewline)
}

export function getTabsTabCount(source: string, sourceLine: number): number | null {
  return locateTabsStructure(source, sourceLine)?.tabs.length ?? null
}

export function renameTabInSource(source: string, sourceLine: number, tabIndex: number, newTitle: string): string | null {
  const structure = locateTabsStructure(source, sourceLine)
  const target = structure?.tabs[tabIndex]
  if (!structure || !target) return null
  const title = newTitle.trim()
  if (!title) return null
  const lines = structure.lines
  const markerRaw = lines[target.markerLine]
  if (markerRaw === undefined) return null
  if (target.prefix) {
    lines[target.markerLine] = `${structure.indent}${target.prefix}${title}`
  }
  else {
    // The panel above the first separator has no marker to rewrite, so the rename gives it one.
    lines.splice(target.markerLine, 0, `${lineIndent(markerRaw)}:: ${title}`)
  }
  return joinLines(lines, structure.eol, structure.trailingNewline)
}

export function deleteTabInSource(source: string, sourceLine: number, tabIndex: number): string | null {
  const structure = locateTabsStructure(source, sourceLine)
  const target = structure?.tabs[tabIndex]
  if (!structure || !target || structure.tabs.length <= 1) return null
  structure.lines.splice(target.markerLine, target.endLine - target.markerLine)
  // Swallow one blank line left at the join so the edit never piles up empty lines.
  const join = target.markerLine
  if (join > 0 && join < structure.lines.length && !structure.lines[join]!.trim() && !structure.lines[join - 1]!.trim())
    structure.lines.splice(join, 1)
  return joinLines(structure.lines, structure.eol, structure.trailingNewline)
}

/** Appends a tab in the spelling the block already uses, numbered after the ones it has. */
export function addTabToSource(source: string, sourceLine: number, tabTitle?: string): string | null {
  const structure = locateTabsStructure(source, sourceLine)
  if (!structure) return null
  const { indent, closeLine, kind, tabs } = structure
  const title = tabTitle?.trim() || (tabs.length ? `${t('common.tabs')} ${tabs.length + 1}` : t('common.tabs'))
  const itemMarker = kind === 'directive' ? ':'.repeat(Math.max(3, structure.markerLength - 1)) : ''
  const insert = kind === 'directive'
    ? [`${indent}${itemMarker} tab-item ${title}`, indent, `${indent}${itemMarker}`]
    : kind === 'at'
      ? [`${indent}@tab ${title}`, indent]
      : [`${indent}:: ${title}`, indent]
  structure.lines.splice(closeLine, 0, ...insert)
  return joinLines(structure.lines, structure.eol, structure.trailingNewline)
}
