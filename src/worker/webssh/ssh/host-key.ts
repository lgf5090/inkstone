// Derived from EdgeSSH 2026-11 snapshot (Apache-2.0) src/ssh/host-key.ts, with Inkstone adaptations.
// D-06 pins the host key: a changed fingerprint must stop the connection before credentials go out.

export type HostKeyTrust = 'trusted' | 'first-seen' | 'changed'

export function classifyHostKey(expectedFingerprint: string | undefined, fingerprint: string): HostKeyTrust {
  if (!expectedFingerprint) return 'first-seen'
  return expectedFingerprint === fingerprint ? 'trusted' : 'changed'
}
