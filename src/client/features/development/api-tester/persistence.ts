import { gzipSync } from 'fflate'
import { STATE_GZIP_MAX_BYTES, STATE_JSON_MAX_BYTES } from '@shared/development/api-tester/limits'
import { stateDataOf } from '@shared/development/api-tester/state'
import type { ApiTesterState } from '@shared/development/api-tester/types'
import { CLIENT_HEADER } from '@shared/constants'
import { ApiError } from '../../../lib/api'
import { putState } from './api'

export const SAVE_DEBOUNCE_MS = 800

export interface StateSaverOptions {
  read: () => { state: ApiTesterState; workspaceId: string } | null
  onSaving: () => void
  onSaved: (rev: number, savedAt: number) => void
  onConflict: () => void
  onError: (message: string) => void
}

export class StateSaver {
  private timer: ReturnType<typeof setTimeout> | null = null
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
    if (this.blocked) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  block(): void {
    this.blocked = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty || this.blocked || this.saving) return
    await this.save()
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.blocked = true
    this.dirty = false
  }

  private async save(): Promise<void> {
    const snapshot = this.options.read()
    if (!snapshot) return
    const data = stateDataOf(snapshot.state)
    const json = JSON.stringify(data)
    const bytes = new TextEncoder().encode(json)
    if (bytes.byteLength > STATE_JSON_MAX_BYTES) {
      this.dirty = false
      this.options.onError('too_large')
      return
    }
    if (gzipSync(bytes).byteLength > STATE_GZIP_MAX_BYTES) {
      this.dirty = false
      this.options.onError('too_large')
      return
    }
    this.saving = true
    this.options.onSaving()
    try {
      const response = await putState(snapshot.workspaceId, this.rev, data)
      this.rev = response.rev
      this.dirty = false
      this.options.onSaved(response.rev, Date.now())
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.dirty = false
        this.block()
        this.options.onConflict()
      } else {
        this.options.onError(error instanceof Error ? error.message : String(error))
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
