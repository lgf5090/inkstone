import * as acme from 'acme-client'
import { X509Certificate } from '@peculiar/x509'
import { sha256Hex } from '../../../lib/encoding'
import type { CerthubKeyAlgorithm, CerthubSubject } from '@shared/development/certhub/types'

export interface CertificateFacts {
  notBefore: number
  notAfter: number
  issuer: string
  serialNumber: string
  fingerprint: string
  domains: string[]
}

export async function generateKey(algorithm: CerthubKeyAlgorithm): Promise<string> {
  if (algorithm === 'rsa2048') return String(await acme.crypto.createPrivateRsaKey(2048))
  if (algorithm === 'eccp256') return String(await acme.crypto.createPrivateEcdsaKey('P-256'))
  return String(await acme.crypto.createPrivateEcdsaKey('P-384'))
}

export async function createCsr(
  privateKeyPem: string,
  names: string[],
  subject: CerthubSubject,
): Promise<string> {
  const [key, csr] = await acme.crypto.createCsr({
    commonName: names[0],
    altNames: names,
    ...(subject.country ? { country: subject.country } : {}),
    ...(subject.state ? { state: subject.state } : {}),
    ...(subject.locality ? { locality: subject.locality } : {}),
    ...(subject.organization ? { organization: subject.organization } : {}),
    ...(subject.organizationUnit ? { organizationUnit: subject.organizationUnit } : {}),
  }, privateKeyPem)
  if (!String(key).includes('BEGIN')) throw new Error('csr_key_missing')
  return String(csr)
}

export async function parseCertificate(fullchainPem: string): Promise<CertificateFacts> {
  const leafPem = fullchainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0]
  if (!leafPem) throw new Error('certificate_pem_invalid')
  const cert = new X509Certificate(leafPem)
  const raw = new Uint8Array(cert.rawData)
  const infos = await acme.crypto.readCertificateInfo(leafPem)
  return {
    notBefore: infos.notBefore.getTime(),
    notAfter: infos.notAfter.getTime(),
    issuer: String(cert.issuer),
    serialNumber: cert.serialNumber,
    fingerprint: await sha256Hex(raw),
    domains: infos.domains.altNames.length > 0
      ? infos.domains.altNames
      : [infos.domains.commonName],
  }
}
