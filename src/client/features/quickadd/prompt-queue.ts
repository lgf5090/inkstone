/**
 * The asking side of a QuickAdd run: a promise queue the format engine pushes prompts into and the
 * host component pulls out of, plus the draft memory that hands a cancelled answer back on the next
 * run.
 *
 * The queue lives outside React on purpose. A run may be waiting on three prompts while the surface
 * that started it unmounts, and a cancelled or unmounted host must resolve them as "no answer"
 * rather than leave a promise — and therefore the whole capture — hanging forever.
 */
import type { PromptAnswer, PromptRequest } from '../../lib/quickadd/format'

export interface PromptGroup {
  requests: PromptRequest[]
  /** One page asks everything at once; otherwise each request gets its own dialog. */
  onePage: boolean
  choiceId: string
  choiceName: string
  /** Where the run is about to write, so a prompt can name its destination. */
  destination?: string
}

export type PromptAnswers = Map<string, PromptAnswer>

interface Entry {
  group: PromptGroup
  resolve: (answers: PromptAnswers) => void
}

let active: Entry | null = null
let sequence = 0
const waiting: Entry[] = []
const listeners = new Set<() => void>()
/** Answers typed into a prompt that was cancelled, kept per choice so the next run can use them. */
const drafts = new Map<string, PromptAnswer>()
const MAX_DRAFTS = 60

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeQuickAddPrompts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function currentPromptGroup(): PromptGroup | null {
  return active?.group ?? null
}

/**
 * Identifies the group on screen. The host keys its dialogs on this, so answering one prompt and
 * promoting the next cannot inherit the typed text, the filter or the picker state of the previous
 * group — and a dialog whose request list changed shape cannot render a different hook count.
 */
export function currentPromptSequence(): number {
  return sequence
}

export function queuedPromptCount(): number {
  return waiting.length
}

function keyFor(choiceId: string, key: string): string {
  return `${choiceId}\u001F${key}`
}

export function rememberDraft(choiceId: string, key: string, value: PromptAnswer): void {
  const id = keyFor(choiceId, key)
  if (value === null || value === '') {
    drafts.delete(id)
    return
  }
  drafts.set(id, value)
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next()
    if (oldest.done) break
    drafts.delete(oldest.value)
  }
}

export function recallDraft(choiceId: string, key: string): PromptAnswer {
  return drafts.get(keyFor(choiceId, key)) ?? null
}

export function clearQuickAddDrafts(choiceId?: string): void {
  if (!choiceId) {
    drafts.clear()
    return
  }
  for (const id of [...drafts.keys()]) {
    if (id.startsWith(`${choiceId}\u001F`)) drafts.delete(id)
  }
}

/** A draft only fills a token that asked for no default of its own. */
function withDrafts(group: PromptGroup): PromptGroup {
  return {
    ...group,
    requests: group.requests.map((request) => {
      if (request.defaultValue !== '') return request
      const draft = recallDraft(group.choiceId, request.key)
      if (draft === null) return request
      return { ...request, defaultValue: Array.isArray(draft) ? draft.join(', ') : draft }
    }),
  }
}

/**
 * Ask a group of prompts and wait for the answers. A dialog dismissed without an answer contributes
 * `null` for each of its requests: the engine turns that into an empty substitution for an
 * `|optional` token, and the caller decides whether a missing required answer aborts the run.
 */
export function askQuickAddPrompts(group: PromptGroup): Promise<PromptAnswers> {
  const prepared = withDrafts(group)
  return new Promise<PromptAnswers>((resolve) => {
    if (active) waiting.push({ group: prepared, resolve })
    else {
      active = { group: prepared, resolve }
      sequence += 1
    }
    notify()
  })
}

function finish(entry: Entry | null, answers: PromptAnswers, keepDrafts: boolean): void {
  if (!entry) return
  active = null
  sequence += 1
  if (keepDrafts) {
    for (const request of entry.group.requests) {
      const value = answers.get(request.key) ?? null
      rememberDraft(entry.group.choiceId, request.key, value)
    }
  }
  entry.resolve(answers)
  active = waiting.shift() ?? null
  notify()
}

/** Deliver what the page answered. Requests left out of the map count as no answer. */
export function submitQuickAddPrompts(answers: PromptAnswers): void {
  finish(active, answers, true)
}

/** Cancel the active group, keeping whatever was typed in it as this choice's next default. */
export function cancelQuickAddPrompts(typed: PromptAnswers = new Map()): void {
  finish(active, typed, true)
}

export function rejectQuickAddPrompts(): void {
  finish(active, new Map(), false)
}

/** Drop everything outstanding with no answer: used when the host unmounts or the account changes. */
export function resetQuickAddPrompts(): void {
  const entries = active ? [active, ...waiting] : [...waiting]
  active = null
  sequence += 1
  waiting.length = 0
  for (const entry of entries) entry.resolve(new Map())
  notify()
}

let liveHosts = 0

/**
 * Claim the queue for as long as the prompt host is mounted, releasing any outstanding run once the
 * last host is gone. The release is deferred by a task on purpose: StrictMode runs an effect's
 * cleanup and then sets it up again inside the same commit, and a host that drops the queue in that
 * cleanup answers every first prompt with nothing before the reader sees a dialog.
 */
export function attachQuickAddPromptHost(): () => void {
  liveHosts += 1
  return () => {
    liveHosts -= 1
    setTimeout(() => {
      if (liveHosts === 0) resetQuickAddPrompts()
    }, 0)
  }
}
