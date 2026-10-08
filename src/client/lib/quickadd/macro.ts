/**
 * The Macro choice engine: an ordered list of named steps.
 *
 * A macro is how a run does something a template or a capture cannot — ask three questions, branch on
 * an answer, run two other choices, then write what all of that produced. Each step is executed in
 * order against one session, so a variable set at step two is visible to step five, and a step that
 * fails stops the run rather than being skipped: half a morning routine is worse than none.
 *
 * The `script` step is the one that leaves this file; see `macro-script.ts` for what it may and may
 * not reach.
 */
import type { QuickAddChoice, QuickAddMacroChoice, QuickAddStep } from '@shared/quickadd'
import { randomLocalId } from '../../lib/random-id'
import type { PromptAnswer } from './format'
import { buildRuntime, askForInputs, type RunSession } from './runtime'
import { applyDateOrigin, formatWithPrompts, newSession, promptRequest } from './session'
import type { NotePort, QuickAddRunStatus } from './context'
import { runTemplateChoice } from './template'
import { runCaptureChoice } from './capture'
import { runMacroScript } from './macro-script'
import { splitPipes } from './token-grammar'
import { t } from '../../lib/i18n'

const MAX_MACRO_DEPTH = 6
const SCRIPT_TEXT_LIMIT = 20_000

export interface MacroOutcome {
  status: QuickAddRunStatus
  /** Everything the steps produced, which is what `{{MACRO:}}` writes. */
  text: string
}

interface MacroState {
  port: NotePort
  session: RunSession
  collected: string[]
  depth: number
  visited: Set<string>
  openNoteId?: string
  sourceNoteId?: string
}

function compare(value: PromptAnswer, operator: string, wanted: string): boolean {
  const answer = Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value)
  switch (operator) {
    case 'eq': return answer.trim().toLowerCase() === wanted.trim().toLowerCase()
    case 'ne': return answer.trim().toLowerCase() !== wanted.trim().toLowerCase()
    case 'has': return wanted.trim() === '' || answer.toLowerCase().includes(wanted.trim().toLowerCase())
    case 'empty': return answer.trim() === ''
    case 'gt': return Number(answer) > Number(wanted)
    case 'lt': return Number(answer) < Number(wanted)
    default: return false
  }
}

async function runStep(step: QuickAddStep, state: MacroState): Promise<QuickAddRunStatus | null> {
  const { port, session } = state
  const { choice: owner } = session
  switch (step.kind) {
    case 'ask': {
      const options = step.options ? splitPipes(step.options).map((item) => item.trim()).filter(Boolean) : []
      const answers = await askForInputs(session, [promptRequest({
        kind: options.length > 1 ? 'suggester' : 'text',
        key: step.variable || 'answer',
        label: step.label || step.variable || t('quickadd.prompt_answer'),
        options,
        allowCustom: options.length > 1,
        trim: true,
      })])
      if (!answers.has(step.variable || 'answer'))
        return { kind: 'cancelled' }
      return null
    }
    case 'set': {
      const formatted = await formatWithPrompts(step.value, buildRuntime(session, port), session, owner.name)
      session.variables.set(step.variable, formatted.text)
      return null
    }
    case 'insert': {
      const formatted = await formatWithPrompts(step.text, buildRuntime(session, port), session, owner.name)
      if (!port.insertAtCursor(formatted.text, formatted.cursor))
        return { kind: 'failed', reason: t('quickadd.error_editor_unavailable') }
      state.collected.push(formatted.text)
      return null
    }
    case 'create': {
      const formatted = await formatWithPrompts(step.title, buildRuntime(session, port), session, owner.name)
      const body = step.templateId ? await port.templateBody(step.templateId) : ''
      if (body === null) return { kind: 'failed', reason: t('quickadd.error_template_missing') }
      const folder = await formatWithPrompts(step.folderPath, buildRuntime(session, port), session, owner.name)
      const made = await port.create({
        title: formatted.text.trim() || t('quickadd.untitled_note'),
        content: body,
        folderPath: folder.text.trim() || null,
      })
      if (!made) return { kind: 'failed', reason: t('quickadd.error_write_refused') }
      if (step.openAfter) await port.open(made.id)
      state.openNoteId = made.id
      return null
    }
    case 'capture': {
      const target = await formatWithPrompts(step.title, buildRuntime(session, port), session, owner.name)
      const text = await formatWithPrompts(step.text, buildRuntime(session, port), session, owner.name)
      const variableName = `qa-step-${randomLocalId('v')}`
      session.variables.set(variableName, text.text)
      const status = await runCaptureChoice({
        ...baseCapture(session),
        targetMode: 'note',
        targetTitle: target.text,
        writePosition: step.position === 'top' ? 'top' : 'bottom',
        format: { enabled: true, format: `{{VALUE:${variableName}}}` },
      }, port, { sourceNoteId: state.sourceNoteId, day: session.clock.date })
      if (status.kind === 'failed' || status.kind === 'cancelled') return status
      return null
    }
    case 'copy': {
      const formatted = await formatWithPrompts(step.text, buildRuntime(session, port), session, owner.name)
      port.copyText(formatted.text)
      return null
    }
    case 'open': {
      const formatted = await formatWithPrompts(step.title, buildRuntime(session, port), session, owner.name)
      const found = port.findByTitle(formatted.text.trim())
      if (!found) return { kind: 'failed', reason: t('quickadd.error_target_not_found', { title: formatted.text.trim() }) }
      await port.open(found.id)
      return null
    }
    case 'notify': {
      const formatted = await formatWithPrompts(step.text, buildRuntime(session, port), session, owner.name)
      port.notify(owner.name, formatted.text)
      return null
    }
    case 'wait':
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(0, Math.min(step.ms, 30_000)))
      })
      return null
    case 'script': {
      const content = session.destination ? await port.read(session.destination.id) : ''
      const variables: Record<string, string> = {}
      for (const [key, value] of session.variables) {
        if (typeof value === 'string') variables[key] = value
        else if (Array.isArray(value)) variables[key] = value.join(', ')
      }
      const result = await runMacroScript(step.code, {
        variables,
        selection: port.selection(),
        title: session.destination?.title ?? '',
        content,
        date: session.clock.date.toISOString(),
        now: session.clock.now.toISOString(),
      })
      if (result.error)
        return { kind: 'failed', reason: t('quickadd.error_script', { reason: result.error }) }
      for (const [key, value] of Object.entries(result.variables)) session.variables.set(key, value)
      state.collected.push(result.text.slice(0, SCRIPT_TEXT_LIMIT))
      return null
    }
    case 'if': {
      const value = session.variables.get(step.variable) ?? null
      const wanted = (await formatWithPrompts(step.value, buildRuntime(session, port), session, owner.name)).text
      const branch = compare(value, step.operator, wanted) ? step.then : step.else
      for (const nested of branch) {
        const failed = await runStep(nested, state)
        if (failed) return failed
      }
      return null
    }
    case 'choice': {
      if (state.depth >= MAX_MACRO_DEPTH)
        return { kind: 'failed', reason: t('quickadd.error_choice_depth') }
      const target = port.choices().find((entry) => entry.id === step.choiceId)
      if (!target) return { kind: 'failed', reason: t('quickadd.error_choice_gone') }
      if (state.visited.has(target.id))
        return { kind: 'failed', reason: t('quickadd.error_choice_cycle', { name: target.name }) }
      const status = await runNestedChoice(target, state)
      if (status.kind !== 'written' && status.kind !== 'empty') return status
      return null
    }
    default:
      return { kind: 'failed', reason: t('quickadd.error_step_unknown') }
  }
}

function baseCapture(session: RunSession): QuickAddChoice & { type: 'capture' } {
  return {
    id: `${session.base.id}#step`,
    name: session.base.name,
    type: 'capture',
    parentId: null,
    position: 0,
    icon: null,
    color: null,
    enabled: true,
    asCommand: false,
    hotkey: null,
    dateOrigin: 'run',
    targetMode: 'note',
    targetTitle: '',
    createIfMissing: true,
    createTemplateId: null,
    writePosition: 'bottom',
    after: '',
    before: '',
    atSectionEnd: false,
    considerSubsections: false,
    createLineIfMissing: false,
    createAt: 'bottom',
    inline: false,
    replaceExisting: false,
    promptHeading: false,
    blankLine: 'auto',
    orderBy: { by: 'lexical', direction: 'desc', dateFormat: 'YYYY-MM-DD' },
    format: { enabled: true, format: '{{VALUE}}' },
    task: false,
    eachLine: false,
    useSelectionAsValue: null,
    openAfter: false,
    linkToSource: false,
    copyLink: false,
    property: { enabled: false, prompted: false, name: '', action: 'set', createIfMissing: true, format: { enabled: false, format: '{{VALUE}}' } },
  } as never as QuickAddChoice & { type: 'capture' }
}

async function runNestedChoice(choice: QuickAddChoice, state: MacroState): Promise<QuickAddRunStatus> {
  const nested: MacroState = {
    ...state,
    depth: state.depth + 1,
    visited: new Set([...state.visited, state.session.base.id]),
  }
  switch (choice.type) {
    case 'template':
      return runTemplateChoice(choice, state.port, {
        variables: state.session.variables,
        day: state.session.clock.date,
        sourceNoteId: state.sourceNoteId,
      })
    case 'capture':
      return runCaptureChoice(choice, state.port, {
        variables: state.session.variables,
        day: state.session.clock.date,
        sourceNoteId: state.sourceNoteId,
      })
    default:
      return (await runMacroSteps(choice, nested)).status
  }
}

async function runMacroSteps(
  choice: QuickAddChoice,
  state: MacroState,
): Promise<MacroOutcome> {
  if (choice.type !== 'macro') {
    const status = await runNestedChoice(choice, state)
    return { status, text: state.collected.join('') }
  }
  for (const step of choice.steps) {
    const failed = await runStep(step, state)
    if (failed) return { status: failed, text: state.collected.join('') }
  }
  return {
    status: {
      kind: 'written',
      noteId: state.openNoteId ?? state.session.destination?.id ?? state.session.base.id,
      created: false,
      summary: t('quickadd.ran_macro', { name: choice.name }),
    },
    text: state.collected.join(''),
  }
}

export async function runMacroChoice(
  choice: QuickAddMacroChoice,
  port: NotePort,
  options: { sourceNoteId?: string; variables?: Map<string, PromptAnswer>; day?: Date } = {},
): Promise<QuickAddRunStatus> {
  return (await runMacro(choice, port, options)).status
}

/** The macro run behind `{{MACRO:name}}`: its text, not its status. */
export async function runMacro(
  choice: QuickAddMacroChoice,
  port: NotePort,
  options: { sourceNoteId?: string; variables?: Map<string, PromptAnswer>; day?: Date } = {},
): Promise<MacroOutcome> {
  const session = newSession(choice, port, options.variables, options.day, options.sourceNoteId)
  const cancelled = await applyDateOrigin(session)
  if (cancelled) return { status: cancelled, text: '' }
  const state: MacroState = {
    port,
    session,
    collected: [],
    depth: 0,
    visited: new Set<string>([choice.id]),
    sourceNoteId: options.sourceNoteId,
  }
  return runMacroSteps(choice, state)
}

/** Look a macro up by name, the way `{{MACRO:Cleanup}}` does. */
export async function runMacroByName(
  name: string,
  port: NotePort,
  options: { sourceNoteId?: string; variables?: Map<string, PromptAnswer>; day?: Date } = {},
): Promise<string> {
  const wanted = name.trim().toLowerCase()
  const match = port.choices().find((choice) => choice.type === 'macro' && choice.name.trim().toLowerCase() === wanted)
  if (!match || match.type !== 'macro') return ''
  const outcome = await runMacro(match, port, options)
  return outcome.status.kind === 'failed' ? '' : outcome.text
}
