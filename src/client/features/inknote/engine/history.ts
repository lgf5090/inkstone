/**
 * The engine's content undo stack.
 *
 * The host also receives every committed pair, but the canvas keeps its own bounded stack so an undo
 * after a stroke is instant and does not depend on React. Entries hold serialized page snapshots and
 * the page they belong to; a snapshot is never applied to a different page.
 */
import type { InknotePageContent } from '@shared/inknote/types'

export const HISTORY_DEPTH = 100
export const HISTORY_BYTES = 64 * 1024 * 1024

export interface InknoteHistoryEntry {
  before: string
  after: string
  label: string
  page: InknotePageContent
}

/** Two UTF-16 code units per code point is a deliberate over-estimate for the JSON budget. */
function entryBytes(entry: InknoteHistoryEntry): number {
  return (entry.before.length + entry.after.length) * 2
}

export class InknoteHistory {
  private entries: InknoteHistoryEntry[] = []
  private index = -1
  private bytes = 0

  push(entry: InknoteHistoryEntry): void {
    // A new edit invalidates everything that was undone; keeping it would make redo ambiguous.
    if (this.index < this.entries.length - 1) {
      for (const dropped of this.entries.splice(this.index + 1)) this.bytes -= entryBytes(dropped)
    }
    this.entries.push(entry)
    this.bytes += entryBytes(entry)
    this.index = this.entries.length - 1
    this.trim()
  }

  undo(): InknoteHistoryEntry | null {
    if (this.index < 0) return null
    const entry = this.entries[this.index]!
    this.index -= 1
    return entry
  }

  redo(): InknoteHistoryEntry | null {
    if (this.index >= this.entries.length - 1) return null
    this.index += 1
    return this.entries[this.index]!
  }

  get canUndo(): boolean {
    return this.index >= 0
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1
  }

  clear(): void {
    this.entries = []
    this.index = -1
    this.bytes = 0
  }

  private trim(): void {
    while (this.entries.length > HISTORY_DEPTH || (this.bytes > HISTORY_BYTES && this.entries.length > 1)) {
      const dropped = this.entries.shift()
      if (!dropped) break
      this.bytes -= entryBytes(dropped)
      if (this.index >= 0) this.index -= 1
    }
    // A redo tail dropped by the byte budget cannot leave the cursor past the live entry.
    this.index = Math.min(this.index, this.entries.length - 1)
  }
}
