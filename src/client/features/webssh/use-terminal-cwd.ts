const CD_COMMAND = /^\s*cd(?:\s+(.*))?\s*$/
const UNSAFE_CD = /[;&|`$(){}<>*?\n\r]/
const OSC7 = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g

function normalize(path: string): string {
  const parts = path.split('/')
  const output: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      output.pop()
      continue
    }
    output.push(part)
  }
  return `/${output.join('/')}`
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function resolveCdCommand(command: string, currentPath: string, homePath: string): string | null {
  const match = CD_COMMAND.exec(command)
  if (!match) return null
  const raw = (match[1] ?? '').trim()
  if (UNSAFE_CD.test(raw)) return null
  if (raw === '') return normalize(homePath)
  const doubleQuoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
  const singleQuoted = raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")
  const unquoted = doubleQuoted || singleQuoted ? raw.slice(1, -1) : raw
  if (/[\0]/.test(unquoted)) return null
  const target = unquoted.startsWith('~')
    ? `${normalize(homePath)}${unquoted.slice(1)}`
    : unquoted.startsWith('/')
      ? unquoted
      : `${normalize(currentPath)}/${unquoted}`
  return normalize(target)
}

export function parseOsc7Path(data: string): string | null {
  OSC7.lastIndex = 0
  let match: RegExpExecArray | null
  let found: string | null = null
  while ((match = OSC7.exec(data)) !== null) {
    if (match[1]) found = normalize(decodePath(match[1]))
  }
  return found
}
