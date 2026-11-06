// Derived from EdgeSSH 2026-11 snapshot (Apache-2.0) src/ssh/transport.ts, with Inkstone adaptations.
// RFC 4253 section 4.2 identification strings. The local line has no CRLF in the exchange hash.

export const SSH_VERSION = 'SSH-2.0-InkstoneWebSSH_1.0'

export function isSSH2Identification(value: string): boolean {
  return value.startsWith('SSH-2.0-') || value.startsWith('SSH-1.99-')
}

export class SSHTransport {
  private remoteVersion = ''
  private readonly localVersion = SSH_VERSION

  setRemoteVersion(version: string): void {
    this.remoteVersion = version
  }

  getRemoteVersion(): string {
    return this.remoteVersion
  }

  getLocalVersion(): string {
    return this.localVersion
  }

  getLocalIdentification(): Uint8Array {
    return new TextEncoder().encode(`${this.localVersion}\r\n`)
  }
}
