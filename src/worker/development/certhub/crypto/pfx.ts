import * as forge from 'node-forge'

const asn1 = forge.asn1
const pki = forge.pki
const oids = forge.pki.oids

interface BagOptions {
  friendlyName?: string
}

function derFromPem(pemBlock: string): string {
  const message = forge.pem.decode(pemBlock)[0]
  if (!message) throw new Error('pem_block_invalid')
  return message.body
}

function privateKeyPkcs8(pem: string): forge.asn1.Asn1 {
  const message = forge.pem.decode(pem)[0]
  if (!message) throw new Error('private_key_invalid')
  if (message.type === 'PRIVATE KEY') return asn1.fromDer(message.body)
  if (message.type === 'RSA PRIVATE KEY') return pki.wrapRsaPrivateKey(asn1.fromDer(message.body))
  if (message.type === 'EC PRIVATE KEY') {
    const sec1 = asn1.fromDer(message.body) as forge.asn1.Asn1 & { value: forge.asn1.Asn1[] }
    const parameters = sec1.value.find((child) => child.tagClass === asn1.Class.CONTEXT_SPECIFIC && child.type === 0)
    const inner = parameters && Array.isArray(parameters.value) ? parameters.value[0] : null
    if (!inner || inner.type !== asn1.Type.OID) throw new Error('ec_curve_missing')
    const curveOid = inner.value as string
    return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(0).getBytes()),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer('1.2.840.10045.2.1').getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, curveOid),
      ]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, message.body),
    ])
  }
  throw new Error(`private_key_unsupported:${message.type}`)
}

function bagAttributes(certDer: string, options: BagOptions): forge.asn1.Asn1 {
  const sha1 = forge.md.sha1.create()
  sha1.update(certDer)
  const localKeyId = sha1.digest().getBytes()
  const attrs: forge.asn1.Asn1[] = [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.localKeyId).getBytes()),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, localKeyId),
      ]),
    ]),
  ]
  if (options.friendlyName) {
    attrs.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.friendlyName).getBytes()),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BMPSTRING, false, options.friendlyName),
      ]),
    ]))
  }
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, attrs)
}

function certSafeContent(certDers: string[], options: BagOptions): forge.asn1.Asn1 {
  const bags = certDers.map((certDer, index) => {
    const attrs = index === 0 ? bagAttributes(certDer, options) : undefined
    return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.certBag).getBytes()),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.x509Certificate).getBytes()),
          asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, certDer),
          ]),
        ]),
      ]),
      ...(attrs ? [attrs] : []),
    ])
  })
  const contents = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, bags)
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.data).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, asn1.toDer(contents).getBytes()),
    ]),
  ])
}

function keySafeContent(pkcs8: forge.asn1.Asn1, password: string, options: BagOptions, certDer: string): forge.asn1.Asn1 {
  const encrypted = pki.encryptPrivateKeyInfo(pkcs8, password, {
    algorithm: 'aes256',
    count: 2048,
    saltSize: 8,
  } as forge.pki.EncryptionOptions)
  const keyBag = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.pkcs8ShroudedKeyBag).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [encrypted]),
    bagAttributes(certDer, options),
  ])
  const contents = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [keyBag])
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.data).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, asn1.toDer(contents).getBytes()),
    ]),
  ])
}

function macData(password: string, authenticatedSafe: forge.asn1.Asn1, saltSize: number, count: number): forge.asn1.Asn1 {
  const salt = forge.util.createBuffer(forge.random.getBytesSync(saltSize))
  const key = forge.pkcs12.generateKey(password, salt, 3, count, 20)
  const hmac = forge.hmac.create()
  hmac.start(forge.md.sha1.create(), key)
  hmac.update(asn1.toDer(authenticatedSafe).getBytes())
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.sha1).getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''),
      ]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, hmac.getMac().getBytes()),
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, salt.getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(count).getBytes()),
  ])
}

export function pemToPfx(
  privateKeyPem: string,
  fullchainPem: string,
  password: string,
  friendlyName: string,
): Uint8Array {
  const pkcs8 = privateKeyPkcs8(privateKeyPem)
  const certBlocks = fullchainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  const certDers = certBlocks.map(derFromPem)
  if (certDers.length === 0) throw new Error('certificate_chain_empty')
  const options = { friendlyName }
  const authenticatedSafe = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    certSafeContent(certDers, options),
    keySafeContent(pkcs8, password, options, certDers[0]!),
  ])
  const pfx = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(3).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oids.data).getBytes()),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, asn1.toDer(authenticatedSafe).getBytes()),
      ]),
    ]),
    macData(password, authenticatedSafe, 8, 2048),
  ])
  const der = asn1.toDer(pfx).getBytes()
  const out = new Uint8Array(der.length)
  for (let index = 0; index < der.length; index += 1) out[index] = der.charCodeAt(index) & 0xff
  return out
}
