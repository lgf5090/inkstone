/**
 * Which grammar colours a side of the comparison.
 *
 * The language follows the file name when one is known, and a manual choice otherwise. The grammars
 * are the ones the notebook already ships (JavaScript, Markdown, SQL) plus CodeMirror's ported legacy
 * modes for everything else, imported one by one so a comparison of two `.txt` files never pays for
 * a Python parser it will not use.
 */
import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { sql } from '@codemirror/lang-sql'
import { c, cpp, java } from '@codemirror/legacy-modes/mode/clike'
import { css } from '@codemirror/legacy-modes/mode/css'
import { python } from '@codemirror/legacy-modes/mode/python'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { xml } from '@codemirror/legacy-modes/mode/xml'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { go } from '@codemirror/legacy-modes/mode/go'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import type { CompareLanguage } from '../store'

export interface LanguageChoice {
  id: CompareLanguage
  labelKey: string
}

export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  { id: 'auto', labelKey: 'tools.compare.language.auto' },
  { id: 'plain', labelKey: 'tools.compare.language.plain' },
  { id: 'javascript', labelKey: 'tools.compare.language.javascript' },
  { id: 'typescript', labelKey: 'tools.compare.language.typescript' },
  { id: 'json', labelKey: 'tools.compare.language.json' },
  { id: 'markdown', labelKey: 'tools.compare.language.markdown' },
  { id: 'sql', labelKey: 'tools.compare.language.sql' },
  { id: 'html', labelKey: 'tools.compare.language.html' },
  { id: 'xml', labelKey: 'tools.compare.language.xml' },
  { id: 'css', labelKey: 'tools.compare.language.css' },
  { id: 'yaml', labelKey: 'tools.compare.language.yaml' },
  { id: 'toml', labelKey: 'tools.compare.language.toml' },
  { id: 'python', labelKey: 'tools.compare.language.python' },
  { id: 'shell', labelKey: 'tools.compare.language.shell' },
  { id: 'c', labelKey: 'tools.compare.language.c' },
  { id: 'cpp', labelKey: 'tools.compare.language.cpp' },
  { id: 'java', labelKey: 'tools.compare.language.java' },
  { id: 'go', labelKey: 'tools.compare.language.go' },
  { id: 'rust', labelKey: 'tools.compare.language.rust' },
  { id: 'diff', labelKey: 'tools.compare.language.diff' },
  { id: 'properties', labelKey: 'tools.compare.language.properties' },
]

const BY_EXTENSION: Readonly<Record<string, CompareLanguage>> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sql: 'sql',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml',
  css: 'css', scss: 'css', less: 'css',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  py: 'python', pyw: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  java: 'java',
  go: 'go',
  rs: 'rust',
  patch: 'diff', diff: 'diff',
  ini: 'properties', conf: 'properties', env: 'properties', properties: 'properties',
}

/** The grammar a filename suggests, or `plain` when nothing about it is familiar. */
export function languageForFilename(filename: string): CompareLanguage {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim())
  if (!match) return 'plain'
  return BY_EXTENSION[match[1]!.toLowerCase()] ?? 'plain'
}

/** The extension a chosen language adds to an editor, or an empty list for plain text. */
export function languageExtension(language: CompareLanguage, filename: string): Extension[] {
  const resolved = language === 'auto' ? languageForFilename(filename) : language
  switch (resolved) {
    case 'javascript':
      return [javascript()]
    case 'typescript':
      return [javascript({ typescript: true, jsx: true })]
    case 'markdown':
      return [markdown()]
    case 'sql':
      return [sql()]
    case 'json':
      return [json()]
    case 'html':
    case 'xml':
      return [StreamLanguage.define(xml)]
    case 'css':
      return [StreamLanguage.define(css)]
    case 'yaml':
      return [StreamLanguage.define(yaml)]
    case 'toml':
      return [StreamLanguage.define(toml)]
    case 'python':
      return [StreamLanguage.define(python)]
    case 'shell':
      return [StreamLanguage.define(shell)]
    case 'c':
      return [StreamLanguage.define(c)]
    case 'cpp':
      return [StreamLanguage.define(cpp)]
    case 'java':
      return [StreamLanguage.define(java)]
    case 'go':
      return [StreamLanguage.define(go)]
    case 'rust':
      return [StreamLanguage.define(rust)]
    case 'diff':
      return [StreamLanguage.define(diff)]
    case 'properties':
      return [StreamLanguage.define(properties)]
    case 'plain':
    case 'auto':
    default:
      return []
  }
}
