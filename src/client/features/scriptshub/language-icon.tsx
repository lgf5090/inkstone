/**
 * One language glyph, drawn inline.
 *
 * The shape and colour are data about a language rather than theme tokens: a Python file keeps its
 * blue-and-yellow mark in either theme, exactly as the extension it wears does. No bitmap or icon
 * font is shipped, so there is no licence to carry and no extra request when a list of forty files
 * draws forty of these.
 */
import type { ScriptIconId } from '@shared/scriptshub/languages'

interface Mark {
  /** Two brand colours, drawn as the plate and the glyph. */
  plate: string
  glyph: string
  /** The letters a compact square mark carries, when it is not a drawn shape. */
  code?: string
}

const MARKS: Record<ScriptIconId, Mark> = {
  shell: { plate: '#2f3a33', glyph: '#9ee6a8', code: '>_' },
  powershell: { plate: '#1d3a63', glyph: '#8ec5ff', code: 'PS' },
  python: { plate: '#2f4a6b', glyph: '#ffd66b', code: 'Py' },
  javascript: { plate: '#3a3520', glyph: '#f7df1e', code: 'JS' },
  typescript: { plate: '#1e3557', glyph: '#6ea8ff', code: 'TS' },
  json: { plate: '#3a3320', glyph: '#e8c16a', code: '{}' },
  yaml: { plate: '#3a2028', glyph: '#f08aa2', code: 'Y' },
  toml: { plate: '#2f2735', glyph: '#caa8f0', code: 'T' },
  sql: { plate: '#20343a', glyph: '#7ddbd0', code: 'SQL' },
  markdown: { plate: '#2c2c30', glyph: '#e6e6ea', code: 'M' },
  ruby: { plate: '#3b2020', glyph: '#ff7a7a', code: 'Rb' },
  go: { plate: '#1c3640', glyph: '#79d7e8', code: 'Go' },
  rust: { plate: '#3a2418', glyph: '#ef9a62', code: 'Rs' },
  php: { plate: '#2c2840', glyph: '#b3a4f0', code: 'php' },
  lua: { plate: '#1c2c45', glyph: '#8ab4ff', code: 'Lua' },
  batch: { plate: '#33362f', glyph: '#c8d17a', code: 'BAT' },
  dockerfile: { plate: '#173248', glyph: '#68b6ff', code: 'D' },
  text: { plate: '#34302a', glyph: '#d9cbb8', code: 'TXT' },
}

export function LanguageIcon({ id, size = 16, className }: {
  id: ScriptIconId
  size?: number
  className?: string
}) {
  const mark = MARKS[id]
  const initials = mark.code ?? ''
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="22" height="22" rx="5" fill={mark.plate} />
      {initials.length > 2
        ? <text x="12" y="16" textAnchor="middle" fontSize="8" fontFamily="ui-monospace, monospace" fontWeight="700" fill={mark.glyph}>{initials}</text>
        : <text x="12" y="16.5" textAnchor="middle" fontSize="10" fontFamily="ui-monospace, monospace" fontWeight="700" fill={mark.glyph}>{initials}</text>}
    </svg>
  )
}

/** The small, unlabelled alias a text-only row uses. */
export function languageIconId(value: string | null | undefined): ScriptIconId {
  return (value && value in MARKS ? value : 'text') as ScriptIconId
}
