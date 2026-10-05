


export class BackupConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupConfigError'
  }
}

export function parseBackupEndpoint(rawValue: string, label: string): URL {
  const raw = rawValue.trim()
  if (!raw) throw new BackupConfigError(`Enter ${label}`)
  const candidate = hasScheme(raw) ? raw : `https://${raw}`
  if (hasRawPathTraversal(candidate)) {
    throw new BackupConfigError(`${label} path cannot contain . or .. segments`)
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new BackupConfigError(`${label} has an invalid format`)
  }

  if (url.protocol !== 'https:') {
    throw new BackupConfigError(`${label} must use HTTPS`)
  }
  if (url.username || url.password) {
    throw new BackupConfigError(`${label} cannot include a username or password in the URL`)
  }
  if (url.search || url.hash) {
    throw new BackupConfigError(`${label} cannot include a query or fragment`)
  }
  if (isUnsafeHostname(url.hostname)) {
    throw new BackupConfigError(`${label} cannot point to localhost, private, or reserved addresses`)
  }
  if (hasTraversalSegment(url.pathname)) {
    throw new BackupConfigError(`${label} path cannot contain . or .. segments`)
  }
  return url
}

export function normalizeBackupPrefix(value: string): string {
  const prefix = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  validateBackupPrefix(prefix)
  return prefix
}

export function validateBackupPrefix(value: string): void {
  if (!value) return
  for (const rawSegment of value.replace(/\\/g, '/').split('/')) {
    let segment: string
    try {
      segment = decodeURIComponent(rawSegment)
    } catch {
      throw new BackupConfigError('Path prefix contains invalid escaping')
    }
    if (!segment || segment === '.' || segment === '..') {
      throw new BackupConfigError('Path prefix cannot contain empty, . or .. segments')
    }
    if (/\p{Cc}/u.test(segment)) {
      throw new BackupConfigError('Path prefix cannot contain control characters')
    }
  }
}

export function normalizeS3Region(value: string | undefined): string {
  const region = value?.trim() || 'auto'
  if (region !== 'auto' && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(region)) {
    throw new BackupConfigError('Region has an invalid format')
  }
  return region
}

export function validateS3Bucket(bucketValue: string, pathStyle: boolean): string {
  const bucket = bucketValue.trim()
  if (!bucket) throw new BackupConfigError('Enter a bucket name')
  const valid = pathStyle
    ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}[A-Za-z0-9]$/.test(bucket) ||
      /^[A-Za-z0-9]$/.test(bucket)
    : /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) &&
      !bucket.includes('..') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(bucket)
  if (!valid) {
    throw new BackupConfigError(
      pathStyle
        ? 'Bucket names may contain only letters, numbers, dots, underscores, and hyphens'
        : 'A virtual-hosted bucket must be a 3-63 character lowercase DNS name',
    )
  }
  return bucket
}

function hasScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
}

function hasTraversalSegment(pathname: string): boolean {
  return pathname.split('/').some((raw) => {
    if (!raw) return false
    try {
      const value = decodeURIComponent(raw)
      return value === '.' || value === '..' || value.includes('/') || value.includes('\\')
    } catch {
      return true
    }
  })
}

function hasRawPathTraversal(value: string): boolean {
  const authority = value.indexOf('//')
  const pathStart = authority >= 0 ? value.indexOf('/', authority + 2) : value.indexOf('/')
  if (pathStart < 0) return false
  const query = value.indexOf('?', pathStart)
  const hash = value.indexOf('#', pathStart)
  const ends = [query, hash].filter((position) => position >= 0)
  const pathEnd = ends.length ? Math.min(...ends) : value.length
  return hasTraversalSegment(value.slice(pathStart, pathEnd))
}

// Hostname screening cannot see through attacker-controlled DNS answers
// that resolve to private addresses; the deployment's
// global_fetch_strictly_public compatibility flag remains the hard outer
// guard and must stay enabled in every wrangler config.
function isUnsafeHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!hostname || !hostname.includes('.')) {
    if (!hostname.includes(':')) return true
  }
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localdomain') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home') ||
    hostname === 'home.arpa' ||
    hostname.endsWith('.home.arpa') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.example') ||
    hostname === 'instance-data.ec2.internal' ||
    hostname === 'metadata.google.internal'
  ) {
    return true
  }

  const ipv4 = parseIpv4(hostname)
  if (ipv4) return isUnsafeIpv4(ipv4)
  const ipv6 = parseIpv6(hostname)
  if (ipv6) return isUnsafeIpv6(ipv6)
  return false
}

function parseIpv4(value: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null
  const parts = value.split('.').map(Number)
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null
}

function isUnsafeIpv4(parts: number[]): boolean {
  const [a, b, c] = parts as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function parseIpv6(value: string): number[] | null {
  if (!value.includes(':') || value.split('::').length > 2) return null
  const [leftRaw, rightRaw] = value.split('::') as [string, string | undefined]
  const left = leftRaw ? leftRaw.split(':') : []
  const right = rightRaw ? rightRaw.split(':') : []
  const parse = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
    return Number.parseInt(part, 16)
  }
  const leftWords = left.map(parse)
  const rightWords = right.map(parse)
  if (leftWords.some((word) => word === null) || rightWords.some((word) => word === null)) return null
  const missing = 8 - leftWords.length - rightWords.length
  if (rightRaw === undefined ? missing !== 0 : missing < 1) return null
  return [
    ...(leftWords as number[]),
    ...Array.from({ length: missing }, () => 0),
    ...(rightWords as number[]),
  ]
}

function isUnsafeIpv6(words: number[]): boolean {
  const first = words[0]!
  if (words.every((word) => word === 0)) return true
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  if ((first & 0xff00) === 0xff00) return true
  if (first === 0x2001 && words[1] === 0x0db8) return true

  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0)
  if (ipv4Mapped || ipv4Compatible) {
    return isUnsafeIpv4([
      words[6]! >> 8,
      words[6]! & 0xff,
      words[7]! >> 8,
      words[7]! & 0xff,
    ])
  }
  return false
}
