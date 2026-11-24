export interface EmailAuthenticationStatus {
  spf?: string
  dkim?: string
  dmarc?: string
}

export function emailAuthenticationStatus(headers: readonly { key: string, value: string }[]): EmailAuthenticationStatus {
  const value = headers
    .filter((header) => header.key.toLowerCase() === 'authentication-results')
    .map((header) => header.value)
    .join(';')
  const status: EmailAuthenticationStatus = {}
  for (const match of value.matchAll(/\b(spf|dkim|dmarc)\s*=\s*([a-z0-9-]+)/gi)) {
    const mechanism = match[1]!.toLowerCase() as keyof EmailAuthenticationStatus
    status[mechanism] = match[2]!.toLowerCase()
  }
  return status
}
