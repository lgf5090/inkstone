import type { WebsshEgressFailure, WebsshEgressPhase } from '@shared/webssh/types'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../lib/i18n'

const PHASE_KEY: Record<WebsshEgressPhase, MessageKey> = {
  dns: 'webssh.egress.phase.dns',
  connect: 'webssh.egress.phase.connect',
  handshake: 'webssh.egress.phase.handshake',
  auth: 'webssh.egress.phase.auth',
  proxy: 'webssh.egress.phase.proxy',
  jump: 'webssh.egress.phase.jump',
}

const FAILED_KEY: Record<WebsshEgressPhase, MessageKey> = {
  dns: 'webssh.egress.failed.dns',
  connect: 'webssh.egress.failed.connect',
  handshake: 'webssh.egress.failed.handshake',
  auth: 'webssh.egress.failed.auth',
  proxy: 'webssh.egress.failed.proxy',
  jump: 'webssh.egress.failed.jump',
}

/**
 * A single sentence that names the stage, so a reader can tell a TCP failure from a handshake or an
 * authentication failure without reading the raw platform message first.
 */
export function formatEgressFailure(failure: WebsshEgressFailure, fallback?: string): string {
  const reason = failure.message || fallback || t('webssh.egress.unknown_reason')
  return t(FAILED_KEY[failure.phase], {
    phase: t(PHASE_KEY[failure.phase]),
    address: failure.address || '?',
    port: failure.port || '?',
    ms: failure.elapsedMs,
    reason,
  })
}
