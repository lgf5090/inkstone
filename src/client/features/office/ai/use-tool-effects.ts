/**
 * Runs the office effects a local assistant turn brings back.
 *
 * The worker reads files and builds plans; the Univer model lives in this tab. This is the only place
 * that turns an `office.*` effect into a Facade call. It mirrors the music player's effect runner:
 * only the local turn is executed, each activity is claimed once, and a failure is shown to the reader.
 */
import { useEffect } from 'react'
import { isOfficeClientEffect, type OfficeClientEffect } from '@shared/office/ai'
import type { ToolActivity } from '@shared/assistant'
import { t } from '../../../lib/i18n'
import { navigateToPath } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { useAssistant } from '../../chat/assistant-store'
import { useSession } from '../../../store/session'
import { readOfficePrefs } from '../office-prefs'
import { confirm } from '../../../components/overlay'
import { getOfficeEditorHandle } from '../editor/handles'

const STORAGE_KEY = 'inkstone.office.appliedToolEffects'
const MAX_REMEMBERED = 200

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function remembered(): string[] {
  const store = storage()
  if (!store) return []
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

const applied = new Set<string>(remembered())

function persist(): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify([...applied].slice(-MAX_REMEMBERED)))
  } catch {
    // Private mode or a full quota. The in-memory set still stops a double run this session.
  }
}

function claim(activityId: string): boolean {
  if (!activityId || applied.has(activityId)) return false
  applied.add(activityId)
  persist()
  return true
}

function fail(description?: string): void {
  useUi.getState().toast({ title: t('office.ai.failed'), ...(description ? { description } : {}), tone: 'danger' })
}

async function waitForHandle(fileId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const handle = getOfficeEditorHandle(fileId)
    if (handle) return handle
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
}

/**
 * Asks before a plan reaches the document.
 *
 * The turn's write is proposed, not performed: the server never touches a file, this client does — so
 * the reader's consent belongs here, next to the edit. A declined plan is spent (its activity is
 * already claimed), which is what stops the same card from asking twice.
 */
async function askToApply(effect: Extract<OfficeClientEffect, { kind: 'office.apply-plan' }>): Promise<boolean> {
  return confirm({
    title: t('office.ai.confirm.title'),
    description: t('office.ai.confirm.description', {
      count: effect.plan.ops.length,
      summary: effect.plan.summary,
    }),
    confirmLabel: t('office.ai.confirm.apply'),
  })
}

async function runEffect(
  effect: OfficeClientEffect,
  options: { autoApply: boolean, confirmApply: (effect: Extract<OfficeClientEffect, { kind: 'office.apply-plan' }>) => Promise<boolean> },
): Promise<boolean> {
  if (effect.kind === 'office.open') {
    navigateToPath(`/office/${effect.fileType}/${effect.fileId}`)
    return true
  }
  if (effect.kind === 'office.refresh') {
    window.dispatchEvent(new Event('office:refresh'))
    return true
  }
  if (!options.autoApply && !(await options.confirmApply(effect))) {
    useUi.getState().toast({ title: t('office.ai.confirm.declined'), description: effect.plan.summary })
    return false
  }
  // Apply after opening the target, because the effect may arrive while another file is active.
  navigateToPath(`/office/${effect.fileType}/${effect.fileId}`)
  const handle = await waitForHandle(effect.fileId)
  if (!handle) throw new Error(t('office.editor.failed'))
  await handle.applyPlan(effect.plan)
  await handle.flush()
  useUi.getState().toast({
    title: t('office.ai.applied'),
    description: effect.plan.summary,
    tone: 'success',
    action: {
      label: t('office.ai.undo'),
      run: () => {
        handle.undo()
        void handle.flush()
      },
    },
  })
  return true
}

export interface OfficeEffectTurn {
  tools: readonly ToolActivity[]
}

/** Exported so the claim/order decision can be tested without a renderer. */
export interface OfficeEffectOptions {
  /** Skip the confirmation: the reader asked for this in Office settings. */
  autoApply?: boolean
  /** Exposed so the declined and accepted paths can be tested without a renderer. */
  confirmApply?: (effect: Extract<OfficeClientEffect, { kind: 'office.apply-plan' }>) => Promise<boolean>
}

/** The reader's own setting, read at decision time so a change applies without a remount. */
function autoApplyFromSettings(): boolean {
  const userId = useSession.getState().user?.id
  return userId ? readOfficePrefs(userId).autoApplyPlans : false
}

export async function runPendingOfficeEffects(
  turn: OfficeEffectTurn | null,
  remoteStreaming: boolean,
  options: OfficeEffectOptions = {},
): Promise<void> {
  if (!turn || remoteStreaming) return
  const autoApply = options.autoApply ?? autoApplyFromSettings()
  const confirmApply = options.confirmApply ?? askToApply
  for (const tool of turn.tools) {
    if (tool.status !== 'success' || !tool.effect || !isOfficeClientEffect(tool.effect)) continue
    if (!claim(tool.id)) continue
    try {
      const applied = await runEffect(tool.effect, { autoApply, confirmApply })
      if (!applied) return
    } catch (error) {
      fail(error instanceof Error ? error.message : undefined)
      // Stop at the first failure: later effects were planned against a state this one did not reach.
      return
    }
  }
}

export function useOfficeToolEffects(): void {
  const turn = useAssistant((state) => state.turn)
  const remoteStreaming = useAssistant((state) => state.remoteStreaming)
  useEffect(() => {
    void runPendingOfficeEffects(turn, remoteStreaming)
  }, [turn, remoteStreaming])
}