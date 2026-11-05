/**
 * Zod schemas for `/api/tools/network-panel/*`, shared with the client so both ends read the same
 * field names and the same bounds.
 */
import { z } from 'zod'
import { parseNodeUrl } from './engine'
import {
  DEFAULT_NETWORK_PANEL_SETTINGS,
  NETWORK_PANEL_LIMITS,
  STOP_REASONS,
  type NetworkPanelSettings,
} from './types'

const threadSchema = z.number().int().min(NETWORK_PANEL_LIMITS.minThreads).max(NETWORK_PANEL_LIMITS.maxThreads)
const capBytesSchema = z.number().int().min(0).max(NETWORK_PANEL_LIMITS.maxDataBytes)
const capSpeedSchema = z.number().int().min(0).max(NETWORK_PANEL_LIMITS.maxSpeedBps)

/** The settings a reader may change; every field is optional so a toggle sends one key. */
export const SettingsPatchSchema = z.object({
  threads: threadSchema.optional(),
  autoStart: z.boolean().optional(),
  background: z.boolean().optional(),
  showChart: z.boolean().optional(),
  saveHistory: z.boolean().optional(),
  autoRefreshInfo: z.boolean().optional(),
  maxDataBytes: capBytesSchema.optional(),
  maxSpeedBps: capSpeedSchema.optional(),
  nodeId: z.string().min(1).max(40).optional(),
})

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

export const NodeInputSchema = z.object({
  label: z.string().trim().min(1).max(NETWORK_PANEL_LIMITS.maxLabel),
  url: z
    .string()
    .trim()
    .min(1)
    .max(NETWORK_PANEL_LIMITS.maxUrl)
    .refine((value) => parseNodeUrl(value).ok, { message: 'The address is not a usable http(s) URL or a same-origin path' }),
})

export const RunInputSchema = z.object({
  node_label: z.string().trim().min(1).max(NETWORK_PANEL_LIMITS.maxLabel),
  node_url: z.string().trim().max(NETWORK_PANEL_LIMITS.maxUrl),
  bytes_used: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  avg_speed_bps: z.number().min(0).max(NETWORK_PANEL_LIMITS.maxSpeedBps),
  duration_ms: z.number().int().min(0).max(86_400_000),
  threads: threadSchema,
  stop_reason: z.enum(STOP_REASONS),
})

export const RunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(NETWORK_PANEL_LIMITS.runPageMax).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

/** Turns a stored values object into the shape the settings screen reads, with every bound applied. */
export function settingsFromRow(row: Partial<Record<keyof NetworkPanelSettings, unknown>> | null): NetworkPanelSettings {
  const fallback = DEFAULT_NETWORK_PANEL_SETTINGS
  if (!row) return fallback
  return {
    threads: clampInt(row.threads, fallback.threads, NETWORK_PANEL_LIMITS.minThreads, NETWORK_PANEL_LIMITS.maxThreads),
    autoStart: row.autoStart === 1 || row.autoStart === true,
    background: row.background === 1 || row.background === true,
    showChart: row.showChart !== 0 && row.showChart !== false,
    saveHistory: row.saveHistory !== 0 && row.saveHistory !== false,
    autoRefreshInfo: row.autoRefreshInfo !== 0 && row.autoRefreshInfo !== false,
    maxDataBytes: clampInt(row.maxDataBytes, 0, 0, NETWORK_PANEL_LIMITS.maxDataBytes),
    maxSpeedBps: clampInt(row.maxSpeedBps, 0, 0, NETWORK_PANEL_LIMITS.maxSpeedBps),
    nodeId: typeof row.nodeId === 'string' && row.nodeId ? row.nodeId : fallback.nodeId,
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
