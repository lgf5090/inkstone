/**
 * D1 storage for the network panel, scoped by `user_id` on every statement.
 *
 * Settings are one row per reader, written on every change and read with the defaults applied; the
 * node list is bounded and the ledger is pruned on write, so neither can grow without a ceiling the
 * reader did not ask for.
 */
import {
  NETWORK_PANEL_LIMITS,
  type NetworkPanelHistory,
  type NetworkPanelNode,
  type NetworkPanelRun,
  type NetworkPanelRunInput,
  type NetworkPanelRunSummary,
  type NetworkPanelSettings,
  type StopReason,
} from '@shared/tools/network-panel/types'
import { settingsFromRow, type SettingsPatch } from '@shared/tools/network-panel/schemas'
import { newId } from '../../lib/id'

interface SettingsRow {
  threads: number
  auto_start: number
  background: number
  show_chart: number
  save_history: number
  auto_refresh_info: number
  max_data_bytes: number
  max_speed_bps: number
  node_id: string
}

interface NodeRow {
  id: string
  label: string
  url: string
  created_at: number
}

interface RunRow {
  id: string
  node_label: string
  node_url: string
  bytes_used: number
  avg_speed_bps: number
  duration_ms: number
  threads: number
  stop_reason: StopReason
  created_at: number
}

const toSettings = (row: SettingsRow | null): NetworkPanelSettings =>
  settingsFromRow(row
    ? {
        threads: row.threads,
        autoStart: Boolean(row.auto_start),
        background: Boolean(row.background),
        showChart: Boolean(row.show_chart),
        saveHistory: Boolean(row.save_history),
        autoRefreshInfo: Boolean(row.auto_refresh_info),
        maxDataBytes: row.max_data_bytes,
        maxSpeedBps: row.max_speed_bps,
        nodeId: row.node_id,
      }
    : null)

const toNode = (row: NodeRow): NetworkPanelNode => ({
  id: row.id,
  label: row.label,
  url: row.url,
  created_at: row.created_at,
})

const toRun = (row: RunRow): NetworkPanelRun => ({
  id: row.id,
  node_label: row.node_label,
  node_url: row.node_url,
  bytes_used: row.bytes_used,
  avg_speed_bps: row.avg_speed_bps,
  duration_ms: row.duration_ms,
  threads: row.threads,
  stop_reason: row.stop_reason,
  created_at: row.created_at,
})

export class NetworkPanelStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  async getSettings(): Promise<NetworkPanelSettings> {
    const row = await this.db
      .prepare(
        `SELECT threads, auto_start, background, show_chart, save_history, auto_refresh_info,
                max_data_bytes, max_speed_bps, node_id
           FROM tools_NetworkPanel_settings WHERE user_id = ?`,
      )
      .bind(this.userId)
      .first<SettingsRow>()
    return toSettings(row)
  }

  async saveSettings(patch: SettingsPatch): Promise<NetworkPanelSettings> {
    const current = await this.getSettings()
    const next: NetworkPanelSettings = { ...current, ...patch }
    await this.db
      .prepare(
        `INSERT INTO tools_NetworkPanel_settings
           (user_id, threads, auto_start, background, show_chart, save_history, auto_refresh_info,
            max_data_bytes, max_speed_bps, node_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           threads = excluded.threads,
           auto_start = excluded.auto_start,
           background = excluded.background,
           show_chart = excluded.show_chart,
           save_history = excluded.save_history,
           auto_refresh_info = excluded.auto_refresh_info,
           max_data_bytes = excluded.max_data_bytes,
           max_speed_bps = excluded.max_speed_bps,
           node_id = excluded.node_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        this.userId,
        next.threads,
        next.autoStart ? 1 : 0,
        next.background ? 1 : 0,
        next.showChart ? 1 : 0,
        next.saveHistory ? 1 : 0,
        next.autoRefreshInfo ? 1 : 0,
        next.maxDataBytes,
        next.maxSpeedBps,
        next.nodeId,
        nowSeconds(),
      )
      .run()
    return next
  }

  async listNodes(): Promise<NetworkPanelNode[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, label, url, created_at FROM tools_NetworkPanel_nodes
          WHERE user_id = ? ORDER BY created_at DESC, rowid DESC`,
      )
      .bind(this.userId)
      .all<NodeRow>()
    return (results ?? []).map(toNode)
  }

  async createNode(input: { id: string; label: string; url: string }): Promise<NetworkPanelNode> {
    const count = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM tools_NetworkPanel_nodes WHERE user_id = ?`)
      .bind(this.userId)
      .first<{ count: number }>()
    if ((count?.count ?? 0) >= NETWORK_PANEL_LIMITS.maxNodes) {
      throw new Error('node_limit')
    }
    const createdAt = nowSeconds()
    await this.db
      .prepare(
        `INSERT INTO tools_NetworkPanel_nodes (user_id, id, label, url, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(this.userId, input.id, input.label, input.url, createdAt)
      .run()
    return { id: input.id, label: input.label, url: input.url, created_at: createdAt }
  }

  async deleteNode(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM tools_NetworkPanel_nodes WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async recordRun(input: NetworkPanelRunInput): Promise<NetworkPanelRun> {
    const createdAt = nowSeconds()
    const id = newId()
    await this.db
      .prepare(
        `INSERT INTO tools_NetworkPanel_runs
           (user_id, id, node_label, node_url, bytes_used, avg_speed_bps, duration_ms, threads, stop_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.userId,
        id,
        input.node_label,
        input.node_url,
        input.bytes_used,
        input.avg_speed_bps,
        input.duration_ms,
        input.threads,
        input.stop_reason,
        createdAt,
      )
      .run()
    await this.db
      .prepare(
        `DELETE FROM tools_NetworkPanel_runs
          WHERE user_id = ?
            AND id NOT IN (
              SELECT id FROM tools_NetworkPanel_runs
               WHERE user_id = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?
            )`,
      )
      .bind(this.userId, this.userId, NETWORK_PANEL_LIMITS.runRetention)
      .run()
    return {
      id,
      ...input,
      created_at: createdAt,
    }
  }

  async listRuns(limit: number, offset: number): Promise<NetworkPanelHistory> {
    const { results } = await this.db
      .prepare(
        `SELECT id, node_label, node_url, bytes_used, avg_speed_bps, duration_ms, threads, stop_reason, created_at
           FROM tools_NetworkPanel_runs
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(this.userId, limit, offset)
      .all<RunRow>()
    const counted = await this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(bytes_used), 0) AS bytes,
                COALESCE(MAX(avg_speed_bps), 0) AS best,
                COALESCE(AVG(avg_speed_bps), 0) AS average
           FROM tools_NetworkPanel_runs WHERE user_id = ?`,
      )
      .bind(this.userId)
      .first<{ count: number; bytes: number; best: number; average: number }>()
    const summary: NetworkPanelRunSummary = {
      count: counted?.count ?? 0,
      bytes: counted?.bytes ?? 0,
      best_speed_bps: counted?.best ?? 0,
      avg_speed_bps: counted?.average ?? 0,
    }
    return {
      items: (results ?? []).map(toRun),
      total: summary.count,
      summary,
    }
  }

  async deleteRun(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM tools_NetworkPanel_runs WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async clearRuns(): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM tools_NetworkPanel_runs WHERE user_id = ?`)
      .bind(this.userId)
      .run()
    return result.meta?.changes ?? 0
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
