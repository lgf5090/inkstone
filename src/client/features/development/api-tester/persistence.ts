import { STATE_JSON_MAX_BYTES } from '@shared/development/api-tester/limits'
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
  private pending = false
  private editEpoch = 0
  private activeSave: Promise<void> | null = null

  constructor(private readonly options: StateSaverOptions) {}

  setRev(rev: number): void {
    this.rev = rev
    this.blocked = false
  }

  markDirty(): void {
    this.dirty = true
    this.editEpoch += 1
    this.clearRetry()
    this.retryAttempts = 0
    if (this.blocked) return
    if (this.saving) {
      // The in-flight save already carries an older snapshot. Remember that another pass is owed
      // instead of dropping the edit when that save finishes.
      this.pending = true
      return
    }
    this.scheduleSave(SAVE_DEBOUNCE_MS)
  }

  block(): void {
    this.blocked = true
    this.pending = false
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
    if (this.saving) {
      this.pending = true
      return
    }
    void this.save()
  }

  async flush(): Promise<void> {
    let attempts = 0
    while (attempts < 3 && !this.blocked) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      this.clearRetry()
      if (this.saving && this.activeSave) {
        await this.activeSave
        attempts += 1
        continue
      }
      if (!this.dirty) return
      this.pending = false
      await this.save()
      attempts += 1
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private scheduleSave(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.save()
    }, delay)
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

  private save(): Promise<void> {
    if (this.saving) {
      this.pending = true
      return Promise.resolve()
    }
    const task = this.performSave()
    this.activeSave = task
    return task
  }

  private async performSave(): Promise<void> {
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
    const snapshotEpoch = this.editEpoch
    this.saving = true
    this.options.onSaving()
    try {
      const response = await putState(snapshot.workspaceId, this.rev, data)
      this.rev = response.rev
      // An edit made while this PUT was in flight is newer than the snapshot we sent. Keeping the
      // dirty flag guarantees the next close/flush still writes it instead of silently dropping it.
      this.dirty = snapshotEpoch !== this.editEpoch
      this.clearRetry()
      this.retryAttempts = 0
      this.options.onSaved(response.rev)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.dirty = false
        this.pending = false
        this.block()
        this.options.onConflict()
      } else {
        this.options.onError(error instanceof Error ? error.message : String(error))
        this.scheduleRetry()
      }
    } finally {
      this.saving = false
      this.activeSave = null
      if (this.pending) {
        this.pending = false
        this.dirty = true
        this.scheduleSave(SAVE_DEBOUNCE_MS)
      }
    }
  }

  /** The page is going away: one last keepalive write, under the browser's 64 KiB limit. */
  flushOnHide(): void {
    const snapshot = this.options.read()
    if (!snapshot || (!this.dirty && !this.saving) || this.blocked) return
    const json = JSON.stringify({
      workspaceId: snapshot.workspaceId,
      rev: this.rev,
      data: stateDataOf(snapshot.state),
    })
    // The keepalive budget is 64 KiB of *bytes*; counting characters lets a CJK-heavy state through
    // an API that then refuses the whole request.
    if (new TextEncoder().encode(json).byteLength > 60_000) {
      console.warn('[inkstone] API Tester keepalive save skipped: the state does not fit the keepalive budget')
      return
    }
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
