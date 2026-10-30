import { gzipSync } from 'fflate'
import { STATE_GZIP_MAX_BYTES, STATE_JSON_MAX_BYTES } from '@shared/development/api-tester/limits'
import { stateDataOf } from '@shared/development/api-tester/state'
import type { ApiTesterState } from '@shared/development/api-tester/types'
import { CLIENT_HEADER } from '@shared/constants'
import { ApiError } from '../../../lib/api'
import { t } from '../../../lib/i18n'
import { putState } from './api'

export const SAVE_DEBOUNCE_MS = 800
/** Delays before each automatic retry of a failed save; the budget resets on the next edit or success. */
export const SAVE_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const

export interface StateSaverOptions {
  read: () => { state: ApiTesterState; workspaceId: string } | null
  onSaving: () => void
  onSaved: (rev: number) => void
  onConflict: () => void
  onError: (message: string) => void
}

export class StateSaver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempts = 0
  private rev = 0
  private dirty = false
  private blocked = false
  private saving = false

  constructor(private readonly options: StateSaverOptions) {}

  setRev(rev: number): void {
    this.rev = rev
    this.blocked = false
  }

  markDirty(): void {
    this.dirty = true
    this.clearRetry()
    this.retryAttempts = 0
    if (this.blocked) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  block(): void {
    this.blocked = true
    this.clearRetry()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** The user asked for another attempt: spend the whole retry budget again, immediately. */
  retryNow(): void {
    this.clearRetry()
    this.retryAttempts = 0
    this.dirty = true
    if (!this.saving) void this.save()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.clearRetry()
    if (!this.dirty || this.blocked || this.saving) return
    await this.save()
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.clearRetry()
    this.blocked = true
    this.dirty = false
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /**
   * A failed save keeps `dirty`, so the next edit already retries; this covers the case where the
   * user stops editing after the failure and would otherwise never learn the state is unsaved.
   */
  private scheduleRetry(): void {
    const delay = SAVE_RETRY_DELAYS_MS[this.retryAttempts]
    if (delay === undefined) return
    this.retryAttempts += 1
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.save()
    }, delay)
  }

  private async save(): Promise<void> {
    const snapshot = this.options.read()
    if (!snapshot) return
    const data = stateDataOf(snapshot.state)
    const json = JSON.stringify(data)
    const bytes = new TextEncoder().encode(json)
    if (bytes.byteLength > STATE_JSON_MAX_BYTES) {
      this.dirty = false
      this.options.onError(t('development.apitester.app.save_too_large'))
      return
    }
    if (gzipSync(bytes).byteLength > STATE_GZIP_MAX_BYTES) {
      this.dirty = false
      this.options.onError(t('development.apitester.app.save_too_large'))
      return
    }
    this.saving = true
    this.options.onSaving()
    try {
      const response = await putState(snapshot.workspaceId, this.rev, data)
      this.rev = response.rev
      this.dirty = false
      this.clearRetry()
      this.retryAttempts = 0
      this.options.onSaved(response.rev)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.dirty = false
        this.block()
        this.options.onConflict()
      } else {
        this.options.onError(error instanceof Error ? error.message : String(error))
        this.scheduleRetry()
      }
    } finally {
      this.saving = false
    }
  }

  /** The page is going away: one last keepalive write, under the browser's 64 KiB limit. */
  flushOnHide(): void {
    const snapshot = this.options.read()
    if (!snapshot || !this.dirty || this.blocked) return
    const json = JSON.stringify({
      workspaceId: snapshot.workspaceId,
      rev: this.rev,
      data: stateDataOf(snapshot.state),
    })
    if (json.length > 60_000) return
    try {
      void fetch('/api/development/api-tester/state', {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1' },
        body: json,
        credentials: 'same-origin',
      })
    } catch (error) {
      console.warn('[inkstone] API Tester keepalive save failed', error)
    }
  }
}
