import type { Env } from '../../../env'
import type { CerthubCa, CerthubKeyAlgorithm } from '@shared/development/certhub/types'

export interface CerthubDirectory {
  production: string
  staging?: string
}

const DIRECTORIES: Record<Exclude<CerthubCa, 'sslcom'>, CerthubDirectory> = {
  'lets-encrypt': {
    production: 'https://acme-v02.api.letsencrypt.org/directory',
    staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  },
  'google-trust': {
    production: 'https://dv.acme-v02.api.pki.goog/directory',
    staging: 'https://dv.acme-v02.test-api.pki.goog/directory',
  },
  zerossl: {
    production: 'https://acme.zerossl.com/v2/DV90',
  },
  buypass: {
    production: 'https://api.buypass.com/acme/directory',
    staging: 'https://api.test4.buypass.no/acme/directory',
  },
}

export function directoryFor(
  ca: CerthubCa,
  environment: 'production' | 'staging',
  keyAlgorithm: CerthubKeyAlgorithm,
  override?: string,
): string {
  if (override) return override
  if (ca === 'sslcom') {
    return `https://acme.ssl.com/sslcom-dv-${keyAlgorithm === 'rsa2048' ? 'rsa' : 'ecc'}`
  }
  const entry = DIRECTORIES[ca]
  const url = environment === 'staging' ? entry.staging : entry.production
  if (!url) throw new Error(`ca_staging_unsupported:${ca}`)
  return url
}

export function eabFor(env: Env, ca: CerthubCa): { kid: string; hmacKey: string } | undefined {
  const pair = ca === 'google-trust'
    ? [env.CERTHUB_GTS_EAB_KID, env.CERTHUB_GTS_EAB_HMAC]
    : ca === 'zerossl'
      ? [env.CERTHUB_ZEROSSL_EAB_KID, env.CERTHUB_ZEROSSL_EAB_HMAC]
      : ca === 'sslcom'
        ? [env.CERTHUB_SSLCOM_EAB_KID, env.CERTHUB_SSLCOM_EAB_HMAC]
        : ['', '']
  const [kid, hmacKey] = pair
  return kid && hmacKey ? { kid, hmacKey } : undefined
}

export function caFromDirectory(url: string): CerthubCa | null {
  if (url.includes('letsencrypt.org')) return 'lets-encrypt'
  if (url.includes('pki.goog')) return 'google-trust'
  if (url.includes('zerossl.com')) return 'zerossl'
  if (url.includes('acme.ssl.com')) return 'sslcom'
  if (url.includes('buypass')) return 'buypass'
  return null
}

export function isKnownDirectory(url: string): boolean {
  return Object.values(DIRECTORIES).some((entry) => entry.production === url || entry.staging === url)
    || /^https:\/\/acme\.ssl\.com\/sslcom-dv-(rsa|ecc)$/.test(url)
}
