/**
 * Inline Tab completion for the note editor.
 *
 * A completion is one short, tool-less model call made after the caret reaches a clause boundary or a
 * list marker. The answer is drawn as ghost text at the caret and only becomes document text when the
 * reader presses Tab. The request is best-effort: a slow or failed completion disappears rather than
 * interrupting the reader, because typing must never wait on the network.
 */
import { StateEffect, StateField, Prec, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from '@codemirror/view'
import { api } from '../lib/api'

export interface TabCompletionOptions {
  enabled: boolean
  modelId?: string | null
  constraint?: string
}

interface Suggestion {
  from: number
  text: string
}

const TRIGGER = /[\uFF0C\u3002\uFF1A,.:\n]$/
const LIST_TRIGGER = /^\s*(?:[-*+]|\d+\.)\s$/
const DELAY_MS = 800

const setSuggestion = StateEffect.define<Suggestion | null>()

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSuggestion)) return effect.value
    }
    return transaction.docChanged ? null : value
  },
})

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super() }
  eq(other: GhostWidget): boolean { return other.text === this.text }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'text-[var(--text-quaternary)] opacity-60 pointer-events-none'
    span.setAttribute('aria-hidden', 'true')
    span.textContent = this.text
    return span
  }
  ignoreEvent(): boolean { return true }
}

const ghostDecorations = EditorView.decorations.compute([suggestionField], (state) => {
  const suggestion = state.field(suggestionField)
  return suggestion
    ? Decoration.set([Decoration.widget({ widget: new GhostWidget(suggestion.text), side: 1 }).range(suggestion.from)])
    : Decoration.none
})

function accepts(key: string): boolean {
  return TRIGGER.test(key) || LIST_TRIGGER.test(key)
}

/** Whether the text before the caret is a place a completion may be asked for. */
export function isTabCompletionTrigger(beforeLine: string, rawBefore = beforeLine): boolean {
  return accepts(rawBefore.slice(-1)) || LIST_TRIGGER.test(beforeLine)
}

class CompletionRunner {
  private timer: number | null = null
  private controller: AbortController | null = null
  private sequence = 0

  constructor(
    private readonly view: EditorView,
    private readonly options: () => TabCompletionOptions,
  ) {}

  update(update: ViewUpdate): void {
    if (!update.docChanged) return
    const current = this.options()
    if (!current.enabled || this.view.composing) {
      this.cancel()
      return
    }
    const head = update.state.selection.main.head
    const line = update.state.doc.lineAt(head)
    const beforeLine = update.state.sliceDoc(line.from, head)
    const rawBefore = update.state.sliceDoc(Math.max(0, head - 80), head)
    if (!isTabCompletionTrigger(beforeLine, rawBefore)) {
      this.cancel()
      return
    }
    this.schedule(head, current)
  }

  private schedule(head: number, options: TabCompletionOptions): void {
    this.cancel()
    const sequence = ++this.sequence
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.request(head, sequence, options)
    }, DELAY_MS)
  }

  private async request(head: number, sequence: number, options: TabCompletionOptions): Promise<void> {
    if (this.view.state.selection.main.head !== head) return
    const doc = this.view.state.doc.toString()
    if (head > doc.length) return
    const controller = new AbortController()
    this.controller = controller
    const clue = options.constraint?.trim()
    try {
      const answer = await api.assistant.oneShot({
        system: [
          'You complete the reader\'s Markdown note at the caret.',
          'Reply with only the text to insert. No quotes, no explanation, no repetition of the text before the caret.',
          'Keep it to at most two short sentences unless the passage is a list item.',
          clue ? `Additional constraint: ${clue}` : '',
        ].filter(Boolean).join('\n'),
        user: `Before the caret:\n${doc.slice(Math.max(0, head - 3_000), head)}\n\nAfter the caret:\n${doc.slice(head, head + 1_000)}`,
        ...(options.modelId ? { modelId: options.modelId } : {}),
        maxOutputTokens: 120,
        timeoutMs: 15_000,
      })
      if (controller.signal.aborted || sequence !== this.sequence) return
      const text = answer.text.trim()
      if (!text) return
      this.view.dispatch({ effects: setSuggestion.of({ from: this.view.state.selection.main.head, text }) })
    } catch {
      // Best effort by design: a failed completion leaves the note exactly as the reader typed it.
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }

  accept(): boolean {
    const suggestion = this.view.state.field(suggestionField)
    if (!suggestion) return false
    this.view.dispatch({
      changes: { from: suggestion.from, insert: suggestion.text },
      selection: { anchor: suggestion.from + suggestion.text.length },
      effects: setSuggestion.of(null),
    })
    return true
  }

  reject(): boolean {
    if (!this.view.state.field(suggestionField)) return false
    this.view.dispatch({ effects: setSuggestion.of(null) })
    return true
  }

  cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    this.controller?.abort()
    this.controller = null
    this.sequence++
  }
}

const runnerMap = new WeakMap<EditorView, CompletionRunner>()

export function tabCompletionExtension(options: TabCompletionOptions): Extension {
  return [
    suggestionField,
    ghostDecorations,
    ViewPlugin.fromClass(class {
      private readonly runner: CompletionRunner
      private readonly view: EditorView
      constructor(view: EditorView) {
        this.view = view
        this.runner = new CompletionRunner(view, () => options)
        runnerMap.set(view, this.runner)
      }
      update(update: ViewUpdate) { this.runner.update(update) }
      destroy() {
        this.runner.cancel()
        // The WeakMap would collect it anyway; deleting keeps a view that is being torn down from
        // answering a late key press through a stale runner.
        runnerMap.delete(this.view)
      }
    }),
    Prec.high(keymap.of([
      { key: 'Tab', run: (view) => runnerMap.get(view)?.accept() ?? false },
      { key: 'Escape', run: (view) => runnerMap.get(view)?.reject() ?? false },
    ])),
  ]
}
