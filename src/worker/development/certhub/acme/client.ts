import * as acme from 'acme-client'
import type { Env } from '../../../env'
import type { CerthubCa, CerthubKeyAlgorithm } from '@shared/development/certhub/types'
import { directoryFor, eabFor } from './directories'
import { parseAcmeFailure } from './errors'
import { allowInsecureLoopbackAcme } from './transport'

export interface AcmeBundle {
  client: acme.Client
  ca: CerthubCa
  directoryUrl: string
}

export type AcmeChallenge = Parameters<acme.Client['completeChallenge']>[0]

export function buildAcmeClient(
  env: Env,
  ca: CerthubCa,
  keyAlgorithm: CerthubKeyAlgorithm,
  accountKey: string,
  environment: 'production' | 'staging',
  accountUrl: string,
): AcmeBundle {
  const directoryUrl = directoryFor(ca, environment, keyAlgorithm, env.CERTHUB_ACME_DIRECTORY)
  if (env.CERTHUB_ALLOW_INSECURE_ACME === '1' && /^https?:\/\/127\.0\.0\.1:/.test(directoryUrl)) allowInsecureLoopbackAcme()
  const client = new acme.Client({
    directoryUrl,
    accountKey,
    ...(accountUrl ? { accountUrl } : {}),
    ...(eabFor(env, ca) ? { externalAccountBinding: eabFor(env, ca) } : {}),
    backoffAttempts: 3,
    backoffMin: 2500,
    backoffMax: 10000,
  })
  return { client, ca, directoryUrl }
}

export async function registerAccount(
  bundle: AcmeBundle,
  contactEmail: string,
): Promise<string> {
  await bundle.client.createAccount({
    termsOfServiceAgreed: true,
    ...(contactEmail ? { contact: [`mailto:${contactEmail}`] } : {}),
  })
  const accountUrl = bundle.client.getAccountUrl()
  if (!accountUrl) throw new Error('acme_account_url_missing')
  return accountUrl
}

export async function createAcmeOrder(
  bundle: AcmeBundle,
  identifiers: Array<{ type: 'dns' | 'ip'; value: string }>,
): Promise<acme.Order> {
  return bundle.client.createOrder({ identifiers })
}

export async function fetchAcmeOrder(bundle: AcmeBundle, orderUrl: string): Promise<acme.Order> {
  return bundle.client.getOrder({ url: orderUrl } as acme.Order)
}

export async function fetchAuthorizations(bundle: AcmeBundle, orderUrl: string): Promise<acme.Authorization[]> {
  const order = await fetchAcmeOrder(bundle, orderUrl)
  return bundle.client.getAuthorizations(order)
}

export async function challengeKeyAuthorization(
  bundle: AcmeBundle,
  challenge: AcmeChallenge,
): Promise<string> {
  return bundle.client.getChallengeKeyAuthorization(challenge)
}

export async function respondToChallenge(
  bundle: AcmeBundle,
  authorization: acme.Authorization,
  challenge: AcmeChallenge,
): Promise<void> {
  void authorization
  await bundle.client.completeChallenge(challenge)
}

export async function finalizeAcmeOrder(
  bundle: AcmeBundle,
  orderUrl: string,
  csrPem: string,
): Promise<acme.Order> {
  const order = await fetchAcmeOrder(bundle, orderUrl)
  return bundle.client.finalizeOrder(order, csrPem)
}

export async function downloadCertificate(
  bundle: AcmeBundle,
  orderUrl: string,
): Promise<string> {
  const order = await fetchAcmeOrder(bundle, orderUrl)
  return bundle.client.getCertificate(order)
}

export async function revokeAcmeCertificate(
  bundle: AcmeBundle,
  certificatePem: string,
  reason: number,
): Promise<void> {
  await bundle.client.revokeCertificate(certificatePem, { reason })
}

export function classifyAcmeError(error: unknown): ReturnType<typeof parseAcmeFailure> {
  return parseAcmeFailure(error)
}
