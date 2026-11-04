/**
 * The language catalogue a snippet can be written in.
 *
 * One row per language, and every place that has to answer "which language is this" — the file-name
 * extension, the picker, the icon, the `Content-Type` a published script is served with — reads the
 * same row. Splitting those answers is how a `.sh` file ends up highlighted as shell, copied as shell
 * and served as `text/plain`.
 *
 * The icon is a name rather than a component: this module is shared with the Worker, which must not
 * import React. The client maps the name to an inline SVG in its own language-icon component.
 */

export type ScriptLanguageId =
  | 'shell'
  | 'powershell'
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'sql'
  | 'markdown'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'php'
  | 'lua'
  | 'batch'
  | 'dockerfile'
  | 'text'

export type ScriptIconId =
  | 'shell'
  | 'powershell'
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'sql'
  | 'markdown'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'php'
  | 'lua'
  | 'batch'
  | 'dockerfile'
  | 'text'

export interface ScriptLanguage {
  id: ScriptLanguageId
  labelKey:
    | 'scriptshub.language.shell'
    | 'scriptshub.language.powershell'
    | 'scriptshub.language.python'
    | 'scriptshub.language.javascript'
    | 'scriptshub.language.typescript'
    | 'scriptshub.language.json'
    | 'scriptshub.language.yaml'
    | 'scriptshub.language.toml'
    | 'scriptshub.language.sql'
    | 'scriptshub.language.markdown'
    | 'scriptshub.language.ruby'
    | 'scriptshub.language.go'
    | 'scriptshub.language.rust'
    | 'scriptshub.language.php'
    | 'scriptshub.language.lua'
    | 'scriptshub.language.batch'
    | 'scriptshub.language.dockerfile'
    | 'scriptshub.language.text'
  /** Lower-case extensions without the dot. `dockerfile` matches a file named exactly `Dockerfile`. */
  extensions: readonly string[]
  /** The `Content-Type` a published file of this language is served with. */
  contentType: string
  icon: ScriptIconId
  /** The extension a new file of this language gets. */
  defaultExtension: string
}

export const SCRIPT_LANGUAGES: readonly ScriptLanguage[] = [
  {
    id: 'shell',
    labelKey: 'scriptshub.language.shell',
    extensions: ['sh', 'bash', 'zsh', 'ksh'],
    contentType: 'text/x-shellscript; charset=utf-8',
    icon: 'shell',
    defaultExtension: 'sh',
  },
  {
    id: 'powershell',
    labelKey: 'scriptshub.language.powershell',
    extensions: ['ps1', 'psm1'],
    contentType: 'text/plain; charset=utf-8',
    icon: 'powershell',
    defaultExtension: 'ps1',
  },
  {
    id: 'python',
    labelKey: 'scriptshub.language.python',
    extensions: ['py', 'pyw'],
    contentType: 'text/x-python; charset=utf-8',
    icon: 'python',
    defaultExtension: 'py',
  },
  {
    id: 'javascript',
    labelKey: 'scriptshub.language.javascript',
    extensions: ['js', 'mjs', 'cjs'],
    contentType: 'text/javascript; charset=utf-8',
    icon: 'javascript',
    defaultExtension: 'js',
  },
  {
    id: 'typescript',
    labelKey: 'scriptshub.language.typescript',
    extensions: ['ts', 'mts', 'cts', 'tsx'],
    contentType: 'text/plain; charset=utf-8',
    icon: 'typescript',
    defaultExtension: 'ts',
  },
  {
    id: 'json',
    labelKey: 'scriptshub.language.json',
    extensions: ['json', 'jsonc'],
    contentType: 'application/json; charset=utf-8',
    icon: 'json',
    defaultExtension: 'json',
  },
  {
    id: 'yaml',
    labelKey: 'scriptshub.language.yaml',
    extensions: ['yml', 'yaml'],
    contentType: 'text/yaml; charset=utf-8',
    icon: 'yaml',
    defaultExtension: 'yml',
  },
  {
    id: 'toml',
    labelKey: 'scriptshub.language.toml',
    extensions: ['toml'],
    contentType: 'text/plain; charset=utf-8',
    icon: 'toml',
    defaultExtension: 'toml',
  },
  {
    id: 'sql',
    labelKey: 'scriptshub.language.sql',
    extensions: ['sql'],
    contentType: 'text/plain; charset=utf-8',
    icon: 'sql',
    defaultExtension: 'sql',
  },
  {
    id: 'markdown',
    labelKey: 'scriptshub.language.markdown',
    extensions: ['md', 'markdown'],
    contentType: 'text/markdown; charset=utf-8',
    icon: 'markdown',
    defaultExtension: 'md',
  },
  {
    id: 'ruby',
    labelKey: 'scriptshub.language.ruby',
    extensions: ['rb'],
    contentType: 'text/x-ruby; charset=utf-8',
    icon: 'ruby',
    defaultExtension: 'rb',
  },
  {
    id: 'go',
    labelKey: 'scriptshub.language.go',
    extensions: ['go'],
    contentType: 'text/x-go; charset=utf-8',
    icon: 'go',
    defaultExtension: 'go',
  },
  {
    id: 'rust',
    labelKey: 'scriptshub.language.rust',
    extensions: ['rs'],
    contentType: 'text/x-rust; charset=utf-8',
    icon: 'rust',
    defaultExtension: 'rs',
  },
  {
    id: 'php',
    labelKey: 'scriptshub.language.php',
    extensions: ['php'],
    contentType: 'text/x-php; charset=utf-8',
    icon: 'php',
    defaultExtension: 'php',
  },
  {
    id: 'lua',
    labelKey: 'scriptshub.language.lua',
    extensions: ['lua'],
    contentType: 'text/x-lua; charset=utf-8',
    icon: 'lua',
    defaultExtension: 'lua',
  },
  {
    id: 'batch',
    labelKey: 'scriptshub.language.batch',
    extensions: ['bat', 'cmd'],
    contentType: 'text/plain; charset=utf-8',
    icon: 'batch',
    defaultExtension: 'bat',
  },
  {
    id: 'dockerfile',
    labelKey: 'scriptshub.language.dockerfile',
    extensions: ['dockerfile'],
    contentType: 'text/plain; charset=utf-8',
    icon: 'dockerfile',
    defaultExtension: 'dockerfile',
  },
  {
    id: 'text',
    labelKey: 'scriptshub.language.text',
    extensions: ['txt', 'conf', 'ini', 'env', 'properties'],
    contentType: 'text/plain; charset=utf-8',
    icon: 'text',
    defaultExtension: 'txt',
  },
]

const BY_ID = new Map(SCRIPT_LANGUAGES.map((language) => [language.id, language]))
const BY_EXTENSION = new Map<string, ScriptLanguage>()
for (const language of SCRIPT_LANGUAGES) {
  for (const extension of language.extensions) {
    if (!BY_EXTENSION.has(extension)) BY_EXTENSION.set(extension, language)
  }
}

/** Whether a value names a language this app can author. */
export function isScriptLanguage(value: unknown): value is ScriptLanguageId {
  return typeof value === 'string' && BY_ID.has(value as ScriptLanguageId)
}

/** The language row for an id; unknown ids fall back to plain text rather than failing a read. */
export function languageFor(id: string | null | undefined): ScriptLanguage {
  return BY_ID.get(id as ScriptLanguageId) ?? BY_ID.get('text')!
}

/** The language a file name claims, or plain text when its extension is not one we know. */
export function languageFromFileName(name: string): ScriptLanguage {
  const base = name.trim().toLowerCase()
  const bare = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base
  if (bare === 'dockerfile' || bare.startsWith('dockerfile.')) return BY_ID.get('dockerfile')!
  const dot = bare.lastIndexOf('.')
  if (dot < 0 || dot === bare.length - 1) return BY_ID.get('text')!
  return BY_EXTENSION.get(bare.slice(dot + 1)) ?? BY_ID.get('text')!
}

/** The `Content-Type` for a served file, from its name first and its declared language second. */
export function contentTypeForFile(name: string, languageId?: string | null): string {
  const fromName = languageFromFileName(name)
  if (fromName.id !== 'text') return fromName.contentType
  return languageFor(languageId).contentType
}

/** A name for a fresh file in this language, without colliding with the ones already in the snippet. */
export function defaultFileNames(languageId: ScriptLanguageId, count = 1): string[] {
  const language = languageFor(languageId)
  return Array.from({ length: count }, (_, index) => (index === 0
    ? `main.${language.defaultExtension}`
    : `part-${index + 1}.${language.defaultExtension}`))
}
