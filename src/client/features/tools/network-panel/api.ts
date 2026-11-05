/**
 * API client for `/api/tools/network-panel/*`.
 *
 * The speed test itself is not here: its payload is read straight from the response stream by the
 * engine, because a JSON helper would have to buffer exactly the bytes the measurement is counting.
 */
import type {
  NetworkPanelHistory,
  NetworkPanelInfo,
  NetworkPanelNode,
  NetworkPanelRun,
  NetworkPanelRunInput,
  NetworkPanelSettings,
} from '@shared/tools/network-panel/types'
import type { SettingsPatch } from '@shared/tools/network-panel/schemas'
import { request } from '../../../lib/api'

interface ApiData<T> {
  data: T
}

export const networkPanelApi = {
  getSettings: () =>
    request<ApiData<NetworkPanelSettings>>('/api/tools/network-panel/settings')
      .then((response) => response.data),

  saveSettings: (patch: SettingsPatch) =>
    request<ApiData<NetworkPanelSettings>>('/api/tools/network-panel/settings', { method: 'PUT', body: patch })
      .then((response) => response.data),

  listNodes: () =>
    request<ApiData<NetworkPanelNode[]>>('/api/tools/network-panel/nodes')
      .then((response) => response.data),

  createNode: (label: string, url: string) =>
    request<ApiData<NetworkPanelNode>>('/api/tools/network-panel/nodes', {
      method: 'POST',
      body: { label, url },
    }).then((response) => response.data),

  deleteNode: (id: string) =>
    request<ApiData<{ removed: boolean }>>(`/api/tools/network-panel/nodes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then((response) => response.data),

  listRuns: (limit: number, offset: number) =>
    request<ApiData<NetworkPanelHistory>>(
      `/api/tools/network-panel/runs?limit=${limit}&offset=${offset}`,
    ).then((response) => response.data),

  recordRun: (input: NetworkPanelRunInput) =>
    request<ApiData<NetworkPanelRun>>('/api/tools/network-panel/runs', { method: 'POST', body: input })
      .then((response) => response.data),

  deleteRun: (id: string) =>
    request<ApiData<{ removed: boolean }>>(`/api/tools/network-panel/runs/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((response) => response.data),

  clearRuns: () =>
    request<ApiData<{ removed: number }>>('/api/tools/network-panel/runs', { method: 'DELETE' })
      .then((response) => response.data),

  getInfo: () =>
    request<ApiData<NetworkPanelInfo>>('/api/tools/network-panel/info')
      .then((response) => response.data),

  /** Round-trip to this deployment, measured by the caller around this call. */
  ping: async (): Promise<number> => {
    const started = performance.now()
    const response = await fetch('/api/tools/network-panel/ping', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await response.json()
    return Math.round(performance.now() - started)
  },
}
