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

async function runEffect(effect: OfficeClientEffect): Promise<void> {
  if (effect.kind === 'office.open') {
    navigateToPath(`/office/${effect.fileType}/${effect.fileId}`)
    return
  }
  if (effect.kind === 'office.refresh') {
    window.dispatchEvent(new Event('office:refresh'))
    return
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
}

export interface OfficeEffectTurn {
  tools: readonly ToolActivity[]
}

/** Exported so the claim/order decision can be tested without a renderer. */
export async function runPendingOfficeEffects(turn: OfficeEffectTurn | null, remoteStreaming: boolean): Promise<void> {
  if (!turn || remoteStreaming) return
  for (const tool of turn.tools) {
    if (tool.status !== 'success' || !tool.effect || !isOfficeClientEffect(tool.effect)) continue
    if (!claim(tool.id)) continue
    try {
      await runEffect(tool.effect)
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