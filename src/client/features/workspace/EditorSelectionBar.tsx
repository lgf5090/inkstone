/**
 * The small bar that appears over text the reader selected in the note editor.
 *
 * It is the same set of acts the AI toolbar menu offers, moved to where the reader is already looking:
 * the selection itself. The bar never owns the selection — the editor does — so every button re-reads
 * the live document before acting and refuses when the passage has moved.
 */
import { Fragment, useEffect } from 'react'
import { Maximize2, Minimize2, Languages, PanelRight, Sparkles, WandSparkles, Wand2 } from 'lucide-react'
import type { EditorSelectionInfo } from '../../editor/CodeEditor'
import { Button } from '../../components/primitives'
import type { MessageKey } from '../../lib/i18n'
import { t } from '../../lib/i18n'
import { runEditorAi, composeQuoted, type EditorAiAction } from '../chat/editor-ai'
import { useQuickAsk } from '../chat/quick-ask-store'
import { useAssistant } from '../chat/assistant-store'
import { runCursorCommand } from '../chat/cursor-commands'
import { markQuotedRange } from '../../editor/quoted-highlight'
import { getActiveEditorView } from '../../editor/commands'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

const ACTIONS: Array<{ action: EditorAiAction, label: MessageKey, icon: typeof Wand2 }> = [
  { action: 'ask', label: 'assistant.edit.ask', icon: Sparkles },
  { action: 'rewrite', label: 'assistant.edit.rewrite', icon: Wand2 },
  { action: 'summarize', label: 'assistant.edit.summarize', icon: WandSparkles },
  { action: 'translate', label: 'assistant.edit.translate', icon: Languages },
  { action: 'condense', label: 'assistant.edit.condense', icon: Minimize2 },
  { action: 'expand', label: 'assistant.edit.expand', icon: Maximize2 },
]

export function EditorSelectionBar({ selection, onDone }: { selection: EditorSelectionInfo, onDone: () => void }) {
  const noteId = useUi((state) => state.activeNoteId)
  const noteTitle = useNotes((state) => (noteId ? state.notes[noteId]?.title ?? '' : ''))
  const commands = useAssistant((state) => state.cursorCommands).filter((command) => command.enabled)
  const loadCursorCommands = useAssistant((state) => state.loadCursorCommands)
  // The bar is reachable from the notebook without opening the assistant, so it cannot rely on the
  // assistant's bootstrap having run: without this the reader's own commands were missing until they
  // visited the chat tab first.
  useEffect(() => { void loadCursorCommands() }, [loadCursorCommands])
  const run = (action: EditorAiAction) => {
    const view = getActiveEditorView()
    if (!noteId || !view) return
    const doc = view.state.doc.toString()
    // The offsets are re-read from the live document: the bar is a few pixels away from the selection,
    // and the reader may have typed while it was visible.
    const range = view.state.selection.main
    if (range.empty) return
    runEditorAi({
      action,
      noteId,
      noteTitle,
      selection: doc.slice(range.from, range.to),
      whole: doc,
      from: range.from,
      to: range.to,
    })
    onDone()
  }
  const quickAsk = () => {
    const view = getActiveEditorView()
    if (!noteId || !view) return
    const doc = view.state.doc.toString()
    const range = view.state.selection.main
    if (range.empty) return
    useQuickAsk.getState().openPanel({
      noteId,
      noteTitle,
      selection: doc.slice(range.from, range.to),
      whole: doc,
      from: range.from,
      to: range.to,
    }, { top: selection.rect.top + selection.rect.height + 8, left: selection.rect.left })
    onDone()
  }
  const toSidebar = () => {
    const view = getActiveEditorView()
    if (!view || !noteId) return
    const range = view.state.selection.main
    if (range.empty) return
    useAssistant.getState().seedComposer(composeQuoted(view.state.doc.sliceString(range.from, range.to)))
    useUi.getState().setAssistantDock(true)
    if (useAssistant.getState().settings?.keepQuotedHighlight !== false) markQuotedRange(view, { from: range.from, to: range.to })
    onDone()
  }
  return (
    <div
      role="toolbar"
      aria-label={t('assistant.selection.toolbar')}
      // A press on the bar must not take focus from the editor: every action re-reads the live
      // selection, and losing it on mousedown is how the bar's own buttons ran on an empty range.
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-[var(--z-popover)] flex items-center gap-0.5 rounded-[var(--r-full)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-pop)]"
      style={{
        top: Math.max(8, selection.rect.top - 44),
        left: Math.max(8, Math.min(selection.rect.left, window.innerWidth - 720)),
      }}
    >
      {ACTIONS.map(({ action, label, icon: Icon }, index) => (
        <Fragment key={action}>
          {index === 3 && <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />}
          <Button size="sm" variant="ghost" icon={<Icon size={13} />} onClick={() => run(action)}>
            {t(label)}
          </Button>
        </Fragment>
      ))}
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />
      <Button size="sm" variant="ghost" icon={<WandSparkles size={13} />} onClick={quickAsk}>
        {t('assistant.quick_ask.open')}
      </Button>
      <Button size="sm" variant="ghost" icon={<PanelRight size={13} />} onClick={toSidebar}>
        {t('assistant.edit.to_sidebar')}
      </Button>
      {commands.slice(0, 3).map((command) => (
        <Button
          key={command.id}
          size="sm"
          variant="ghost"
          icon={<Wand2 size={13} />}
          onClick={() => {
            const view = getActiveEditorView()
            if (!view || !noteId) return
            const range = view.state.selection.main
            if (range.empty) return
            runCursorCommand(command, view.state.doc.sliceString(range.from, range.to), { id: noteId, title: noteTitle })
            onDone()
          }}
        >
          {command.label}
        </Button>
      ))}
    </div>
  )
}
