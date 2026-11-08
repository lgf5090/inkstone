import * as acme from 'acme-client'

const axios = acme.axios as typeof acme.axios & {
  defaults: {
    adapter: string
    timeout: number
    maxRedirects: number
    acmeSettings: { retryMaxAttempts: number; retryDefaultDelay: number }
  }
}

axios.defaults.adapter = 'fetch'
axios.defaults.timeout = 15_000
axios.defaults.maxRedirects = 0
axios.defaults.acmeSettings.retryMaxAttempts = 0
axios.defaults.acmeSettings.retryDefaultDelay = 2

export function configureAcmeTransport(timeoutMs: number): void {
  axios.defaults.timeout = Math.min(60_000, Math.max(5_000, timeoutMs))
}

export const acmeClientModule = acme
