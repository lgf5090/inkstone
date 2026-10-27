/** The tunnels door: account-scoped tunnel management, the wizard, and zone rulesets. */
import { cfRequest } from './client'

export const WIZARD_PROTOCOLS = ['http', 'https', 'tcp'] as const
export type WizardProtocol = (typeof WIZARD_PROTOCOLS)[number]

export const INGRESS_PROTOCOLS = ['http', 'https', 'tcp', 'custom'] as const
export type IngressProtocol = (typeof INGRESS_PROTOCOLS)[number]

export const RULE_PHASES = [
  'origin',
  'redirect',
  'transform',
  'request_headers',
  'response_headers',
  'cache_settings',
  'firewall',
  'rate_limit',
] as const
export type RulePhase = (typeof RULE_PHASES)[number]

export interface TunnelAccount {
  id: string
  name: string
  cf_account_id: string | null
}

export interface TunnelZone {
  id: string
  name: string
  status: string
}

export interface TunnelConnection {
  id: string
  colo_name: string
  version: string
  ip: string
  opened_at?: string
}

export interface Tunnel {
  id: string
  name: string
  status: string
  created_at: string
  connections: TunnelConnection[]
}

export interface IngressRule {
  hostname?: string
  path?: string
  service: string
  originRequest?: Record<string, unknown>
}

export interface WizardInput {
  mode: 'create' | 'reuse'
  tunnelId?: string
  tunnelName?: string
  hostname: string
  protocol: WizardProtocol
  port: number
  path?: string
}

export interface WizardResult {
  tunnelId: string
  hostname: string
  cnameTarget: string
  mode: WizardInput['mode']
}

export interface TunnelRule {
  id?: string
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  enabled?: boolean
}

export interface RuleInput {
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  enabled: boolean
}

function accountPath(accountId: string, suffix = ''): string {
  return `/tunnels/accounts/${encodeURIComponent(accountId)}${suffix}`
}

function tunnelPath(accountId: string, tunnelId: string, suffix = ''): string {
  return accountPath(accountId, `/tunnels/${encodeURIComponent(tunnelId)}${suffix}`)
}

function rulesPath(accountId: string, zoneId: string, phase: RulePhase, ruleId = ''): string {
  const base = accountPath(
    accountId,
    `/zones/${encodeURIComponent(zoneId)}/rules/${encodeURIComponent(phase)}`,
  )
  return ruleId ? `${base}/${encodeURIComponent(ruleId)}` : base
}

export const tunnelsApi = {
  accounts: () => cfRequest<TunnelAccount[]>('/tunnels/accounts'),

  zones: (accountId: string) => cfRequest<TunnelZone[]>(accountPath(accountId, '/zones')),

  list: (accountId: string) => cfRequest<Tunnel[]>(accountPath(accountId, '/tunnels')),

  create: (accountId: string, name: string) =>
    cfRequest<Tunnel>(accountPath(accountId, '/tunnels'), { method: 'POST', body: { name } }),

  remove: (accountId: string, tunnelId: string) =>
    cfRequest<{ id: string }>(tunnelPath(accountId, tunnelId), { method: 'DELETE' }),

  token: (accountId: string, tunnelId: string) =>
    cfRequest<{ token: string }>(tunnelPath(accountId, tunnelId, '/token')),

  connections: (accountId: string, tunnelId: string) =>
    cfRequest<TunnelConnection[]>(tunnelPath(accountId, tunnelId, '/connections')),

  config: (accountId: string, tunnelId: string) =>
    cfRequest<{ ingress: IngressRule[] }>(tunnelPath(accountId, tunnelId, '/config')),

  saveConfig: (accountId: string, tunnelId: string, ingress: IngressRule[]) =>
    cfRequest<{ ingress: IngressRule[] }>(tunnelPath(accountId, tunnelId, '/config'), {
      method: 'PUT',
      body: { ingress },
    }),

  hostnames: (accountId: string, tunnelId: string) =>
    cfRequest<{ hostnames: string[] }>(tunnelPath(accountId, tunnelId, '/hostnames')),

  wizard: (accountId: string, input: WizardInput) =>
    cfRequest<WizardResult>(accountPath(accountId, '/wizard'), {
      method: 'POST',
      body: input,
      timeoutMs: 120_000,
    }),

  rules: {
    list: (accountId: string, zoneId: string, phase: RulePhase) =>
      cfRequest<{ rules: TunnelRule[] }>(rulesPath(accountId, zoneId, phase)),

    create: (accountId: string, zoneId: string, phase: RulePhase, input: RuleInput) =>
      cfRequest<{ rules: TunnelRule[] }>(rulesPath(accountId, zoneId, phase), {
        method: 'POST',
        body: input,
      }),

    update: (accountId: string, zoneId: string, phase: RulePhase, ruleId: string, input: RuleInput) =>
      cfRequest<{ rules: TunnelRule[] }>(rulesPath(accountId, zoneId, phase, ruleId), {
        method: 'PUT',
        body: input,
      }),

    remove: (accountId: string, zoneId: string, phase: RulePhase, ruleId: string) =>
      cfRequest<{ deleted: string }>(rulesPath(accountId, zoneId, phase, ruleId), { method: 'DELETE' }),
  },
}
