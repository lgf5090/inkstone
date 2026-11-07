/**
 * The alerting screen's door to `/api/cloudflare/alerting`.
 */
import { cfRequest } from './client'

export interface AlertPolicy {
  id: string
  name: string
  description: string
  enabled: boolean
  alertType: string
  emails: string[]
  created: string
  modified: string
}

export interface AlertTypeOption {
  type: string
  displayName: string
  description: string
}

export interface AlertPolicyInput {
  name: string
  description: string
  alertType: string
  enabled: boolean
  emails: string[]
}

const BASE = '/alerting'

export const alertingApi = {
  policies: (accountId: string) =>
    cfRequest<{ policies: AlertPolicy[] }>(`${BASE}/${accountId}/policies`),

  availableAlerts: (accountId: string) =>
    cfRequest<{ alerts: AlertTypeOption[] }>(`${BASE}/${accountId}/available-alerts`),

  createPolicy: (accountId: string, input: AlertPolicyInput) =>
    cfRequest<AlertPolicy>(`${BASE}/${accountId}/policies`, { method: 'POST', body: input }),

  updatePolicy: (accountId: string, policyId: string, input: AlertPolicyInput) =>
    cfRequest<{ saved: true }>(`${BASE}/${accountId}/policies/${encodeURIComponent(policyId)}`, {
      method: 'PUT',
      body: input,
    }),

  deletePolicy: (accountId: string, policyId: string) =>
    cfRequest<{ deleted: true }>(`${BASE}/${accountId}/policies/${encodeURIComponent(policyId)}`, { method: 'DELETE' }),
}
