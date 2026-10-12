/**
 * The minute sweep that runs what is due.
 *
 * Wired into the worker's cron handler alongside the existing queue drains, and deliberately kept out
 * of the hourly branch: a reminder is cheap and late delivery is visible, while the heavy work that
 * runs on the hour (backups, attachment cleanup) must not be able to take the reminders down with it.
 *
 * A routine that calls a model can outlive the sweep that started it, so each automation is claimed
 * before it runs and the claim is only released when it is re-armed — which is what stops a slow AI
 * digest from being started twice by two overlapping ticks.
 */

import type { Automation } from '@shared/assistant'
import { promptCatalog } from '@shared/assistant-prompt'
import { localDayBounds } from '@shared/assistant-time'
import type { Env } from '../env'
import { normalizeAssistantSettings } from '@shared/assistant'
import { initializeDatabase } from '../db/schema'
import { AssistantStore, dueAutomations } from './store'
import { AutomationService } from './automations'
import { AssistantRunner } from './runner'
import { loadModelAndProvider } from './model-config'

/** How many automations one sweep will start, so a backlog cannot monopolise the cron invocation. */
export const DUE_SWEEP_LIMIT = 20

export interface SweepResult {
  started: number
  failed: number
}

export async function runDueAssistantAutomations(env: Env, now = Date.now()): Promise<SweepResult> {
  const due = await dueAutomations(env.DB, now, DUE_SWEEP_LIMIT)
  let started = 0
  let failed = 0
  for (const entry of due) {
    try {
      await runOne(env, entry.userId, entry.automation)
      started++
    } catch (error) {
      failed++
      console.error('[inkstone] assistant automation failed:', error instanceof Error ? error.message : error)
    }
  }
  return { started, failed }
}

async function runOne(env: Env, userId: string, automation: Automation): Promise<void> {
  const db = env.DB
  const { ftsEnabled } = await initializeDatabase(env)
  const store = new AssistantStore(db, userId, env)
  const settings = normalizeAssistantSettings(await store.getSettings())
  const service = new AutomationService(store, settings)
  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled,
    origin: env.PUBLIC_URL ?? '',
    settings,
  })
  const catalog = promptCatalog(settings.language)

  await service.fire(automation, async (entry) => {
    switch (entry.kind) {
      case 'reminder': {
        // A plain reminder never spends AI: the message is the whole answer.
        await store.createNotification({
          title: entry.message || entry.name,
          body: entry.message || entry.name,
          automationId: entry.id,
        })
        return { status: 'success' as const, result: 'delivered' }
      }
      case 'task_digest': {
        const body = await digestBody(store, settings, catalog.digest_overdue, catalog.digest_today, catalog.digest_open, catalog.digest_none)
        await store.createNotification({ title: entry.name, body, automationId: entry.id })
        if (entry.message) {
          // A digest can carry the reader's own note as well as the computed list.
          await store.createNotification({ title: entry.name, body: entry.message, automationId: entry.id })
        }
        return { status: 'success' as const, result: body.slice(0, 300) }
      }
      case 'assistant_prompt': {
        const today = await store.todayUsage()
        if (today.scheduledRuns >= settings.limits.maxScheduledRunsPerDay || !settings.limits.maxScheduledRunsPerDay) {
          await store.createNotification({
            title: entry.name,
            body: catalog.digest_skipped,
            automationId: entry.id,
          })
          return { status: 'skipped' as const, result: 'scheduled ai budget reached' }
        }
        const resolved = await loadModelAndProvider(store, settings)
        if (!resolved.model || !resolved.provider) {
          await store.createNotification({
            title: entry.name,
            body: catalog.digest_skipped,
            automationId: entry.id,
          })
          return { status: 'skipped' as const, result: 'no model configured' }
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 90_000)
        let text = ''
        try {
          text = await runner.runScheduledPrompt(entry.message || entry.name, controller.signal)
        } finally {
          clearTimeout(timer)
        }
        await store.createNotification({ title: entry.name, body: text, automationId: entry.id })
        return { status: 'success' as const, result: text.slice(0, 300) }
      }
    }
  })
}

/**
 * The digest is computed, not generated.
 *
 * A summary of what is due needs the reader's own task rows, and asking a model to list them costs a
 * request, can miss one, and can invent one. The reference project got this right and the shape is
 * kept: overdue first, then today, then the open count.
 */
export async function digestBody(
  store: AssistantStore,
  settings: { timezone: string },
  overdueLabel: string,
  todayLabel: string,
  openLabel: string,
  noneLabel: string,
): Promise<string> {
  const bounds = localDayBounds(settings.timezone)
  const now = Date.now()
  const open = await store.listTasks({ status: 'open', limit: 200 })
  const overdue = open.filter((task) => task.dueAt !== null && task.dueAt < now)
  const today = open.filter((task) => task.dueAt !== null && task.dueAt >= now && task.dueAt < bounds.end)
  const rest = open.length - overdue.length - today.length
  const parts: string[] = []
  if (overdue.length) parts.push(`**${overdueLabel} (${overdue.length})**\n${overdue.map((task) => `- ${task.title}`).join('\n')}`)
  if (today.length) parts.push(`**${todayLabel} (${today.length})**\n${today.map((task) => `- ${task.title}`).join('\n')}`)
  if (!parts.length) parts.push(noneLabel)
  parts.push(`${rest} ${openLabel}`)
  return parts.join('\n\n')
}
