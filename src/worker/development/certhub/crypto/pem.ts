export function splitCertificateChain(fullchainPem: string): { leaf: string; chain: string; all: string[] } {
  const all = fullchainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  const leaf = all[0] ? `${all[0]}\n` : ''
  const chain = all.slice(1).map((block) => `${block}\n`).join('')
  return { leaf, chain, all }
}

export function isPemCertificate(value: string): boolean {
  return /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.test(value)
}

export function isPemPrivateKey(value: string): boolean {
  return /-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----/.test(value)
}
