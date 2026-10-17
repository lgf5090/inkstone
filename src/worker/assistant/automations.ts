/**
 * Reminders and routines.
 *
 * The reference project armed a Durable Object alarm per schedule. This app runs on D1 with a cron
 * tick, so "armed" only means *next_run is in the future and the row is enabled*: the tick sweeps due
 * rows once a minute. That trades a precise alarm for a one-minute window, which is what a reminder
 * can absorb and a scheduler cannot.
 *
 * The two properties that matter and are easy to lose are kept here: a run that takes longer than the
 * sweep interval is claimed so the next tick does not start it twice, and a schedule whose next
 * occurrence is computed from the slot that fired rather than from "now" cannot drift later every time
 * it runs.
 */

import type { AssistantSettings, Automation, AutomationKind } from '@shared/assistant'
import { computeNextRun, parseScheduleSpec } from '@shared/assistant-schedule'
import { ApiError } from '../lib/errors'
import type { AssistantStore } from './store'

export type AutomationExecutor = (automation: Automation) => Promise<{ status: 'success' | 'skipped', result: string }>

/** A run that was missed by more than this is executed once on the next sweep rather than skipped. */
const MAX_CATCH_UP_MS = 24 * 60 * 60 * 1000

export class AutomationService {
  constructor(
    private readonly store: AssistantStore,
    private readonly settings: AssistantSettings,
  ) {}

  private get timezone(): string {
    return this.settings.timezone
  }

  async create(input: {
    name: string
    kind: AutomationKind
    message: string
    schedule: unknown
    enabled: boolean
  }): Promise<Automation> {
    const schedule = parseScheduleSpec(input.schedule)
    if (!schedule) throw ApiError.badRequest('The schedule is not one the assistant understands.')
    if ((input.kind === 'reminder' || input.kind === 'assistant_prompt') && !input.message.trim()) {
      throw ApiError.badRequest(input.kind === 'reminder'
        ? 'A reminder needs a message.'
        : 'An AI routine needs a prompt.')
    }
    const next = computeNextRun(schedule, this.timezone, new Date())
    if (!next) throw ApiError.badRequest('That time is already past. Choose a future time.')
    return this.store.insertAutomation({
      name: input.name.trim().slice(0, 200),
      kind: input.kind,
      message: input.message.trim().slice(0, 4000),
      schedule,
      enabled: input.enabled,
      status: input.enabled ? 'scheduled' : 'paused',
      nextRun: input.enabled ? next.getTime() : null,
    })
  }

  async update(id: string, patch: {
    name?: string
    message?: string
    schedule?: unknown
    enabled?: boolean
  }): Promise<Automation> {
    const existing = await this.store.getAutomation(id)
    if (!existing) throw ApiError.notFound('Automation not found')
    const timingChanged = patch.schedule !== undefined
      || (patch.enabled !== undefined && patch.enabled !== existing.enabled)
    const next: Partial<Automation> = {
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 200) } : {}),
      ...(patch.message !== undefined ? { message: patch.message.trim().slice(0, 4000) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    }
    if (patch.schedule !== undefined) {
      const parsed = parseScheduleSpec(patch.schedule)
      if (!parsed) throw ApiError.badRequest('The schedule is not one the assistant understands.')
      next.schedule = parsed
    }
    if (!timingChanged) {
      await this.store.updateAutomation(id, next)
      const updated = await this.store.getAutomation(id)
      if (!updated) throw ApiError.notFound('Automation not found')
      return updated
    }
    const enabled = next.enabled ?? existing.enabled
    const schedule = next.schedule ?? existing.schedule
    if (!enabled) {
      await this.store.updateAutomation(id, { ...next, enabled: false, status: 'paused', nextRun: null })
    } else {
      const at = computeNextRun(schedule, this.timezone, new Date())
      if (!at) {
        await this.store.updateAutomation(id, { ...next, enabled: false, status: 'completed', nextRun: null })
      } else {
        await this.store.updateAutomation(id, { ...next, enabled: true, status: 'scheduled', nextRun: at.getTime() })
      }
    }
    const updated = await this.store.getAutomation(id)
    if (!updated) throw ApiError.notFound('Automation not found')
    return updated
  }

  async delete(id: string): Promise<void> {
    const existing = await this.store.getAutomation(id)
    if (!existing) throw ApiError.notFound('Automation not found')
    await this.store.deleteAutomation(id)
    await this.store.recordActivity('automation.deleted', existing.name)
  }

  /** Recomputes every schedule, e.g. after the reader changes timezone. */
  async rearmAll(): Promise<number> {
    let moved = 0
    for (const automation of await this.store.listAutomations()) {
      if (!automation.enabled) {
        if (automation.nextRun !== null) {
          await this.store.updateAutomation(automation.id, { status: 'paused', nextRun: null })
          moved++
        }
        continue
      }
      const at = computeNextRun(automation.schedule, this.timezone, new Date())
      if (!at) {
        await this.store.updateAutomation(automation.id, { enabled: false, status: 'completed', nextRun: null })
      } else {
        await this.store.updateAutomation(automation.id, { status: 'scheduled', nextRun: at.getTime() })
      }
      moved++
    }
    return moved
  }

  /**
   * Runs one due automation and arms its next occurrence.
   *
   * The reader may pause, edit or delete while the executor awaits a model, so the row is re-read
   * before anything is written back, and the receipt is kept without claiming a schedule that is no
   * longer ours to set.
   */
  async fire(automation: Automation, execute: AutomationExecutor): Promise<void> {
    const runId = await this.store.startRun(automation)
    // The claim stays on the row for the whole run. Clearing it here used to open a window between the
    // sweep's claim and the re-arm below, and a tick arriving in that window (a model call may outlive
    // the minute sweep) started the same routine a second time. Re-arming is what releases it.
    await this.store.updateAutomation(automation.id, { status: 'running' })
    let result: string | null = null
    let failure: string | null = null
    try {
      const outcome = await execute(automation)
      result = outcome.result.slice(0, 2000)
      await this.store.finishRun(runId, outcome.status, result, null)
    } catch (error) {
      failure = error instanceof Error ? error.message : 'The run failed.'
      await this.store.finishRun(runId, 'error', null, failure)
      await this.store.recordActivity('automation.failed', `${automation.name}: ${failure.slice(0, 160)}`)
    }
    const current = await this.store.getAutomation(automation.id)
    if (!current) return
    const slot = automation.nextRun ?? Date.now()
    const after = new Date(Math.max(Date.now(), slot))
    const missed = Date.now() - slot > MAX_CATCH_UP_MS
    if (!current.enabled) {
      await this.store.updateAutomation(current.id, {
        lastRun: slot,
        lastResult: result,
        lastError: failure,
        runCount: current.runCount + 1,
        // The run is over, so the claim that kept a tick from starting it again goes with it.
        claimedAt: null,
      })
      return
    }
    const next = computeNextRun(current.schedule, this.timezone, after)
    if (!next || (current.schedule.type === 'once' && missed)) {
      await this.store.updateAutomation(current.id, {
        lastRun: slot,
        lastResult: result,
        lastError: failure,
        runCount: current.runCount + 1,
        enabled: false,
        status: 'completed',
        nextRun: null,
        claimedAt: null,
      })
      return
    }
    await this.store.updateAutomation(current.id, {
      lastRun: slot,
      lastResult: result,
      lastError: failure,
      runCount: current.runCount + 1,
      status: failure ? 'failed' : 'scheduled',
      nextRun: next.getTime(),
      // The next occurrence is armed, so another sweep is welcome to start it then.
      claimedAt: null,
    })
  }
}
