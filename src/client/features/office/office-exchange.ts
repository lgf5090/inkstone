/**
 * The external Univer exchange endpoint, when the deployment has one.
 *
 * Importing an xlsx/docx/pptx (or exporting one) is not something the Web SDK can do alone: the bytes
 * have to be converted into a Univer unit by a separate Exchange service. `.env.example` has promised
 * `VITE_UNIVER_EXCHANGE_ENDPOINT` since the first draft, so this module is the code behind that promise:
 * empty means the actions stay hidden, set means the browser may call that origin.
 *
 * The worker never proxies it, so the endpoint must also be allowed by the page's CSP (`connect-src`).
 */
const ENDPOINT = String(import.meta.env.VITE_UNIVER_EXCHANGE_ENDPOINT ?? '').trim().replace(/\/$/, '')

export function officeExchangeEndpoint(): string {
  return ENDPOINT
}

export function officeExchangeEnabled(): boolean {
  return ENDPOINT.length > 0
}
