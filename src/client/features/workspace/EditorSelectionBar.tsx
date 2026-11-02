/**
 * The small bar that appears over text the reader selected in the note editor.
 *
 * It is the same set of acts the AI toolbar menu offers, moved to where the reader is already looking:
 * the selection itself. The bar never owns the selection — the editor does — so every button re-reads
 * the live document before acting and refuses when the passage has moved.
 */
import { Fragment, useRef, useState } from 'react'
import { Maximize2, Minimize2, Languages, PanelRight, Sparkles, WandSparkles, Wand2 } from 'lucide-react'
import type { EditorSelectionInfo } from '../../editor/CodeEditor'
import { Button } from '../../components/primitives'
import { Menu } from '../../components/overlay'
import type { MessageKey } from '../../lib/i18n'
import { t } from '../../lib/i18n'
import { runEditorAi, quotePassage, type EditorAiAction } from '../chat/editor-ai'
import { useQuickAsk } from '../chat/quick-ask-store'
import { useAssistant } from '../chat/assistant-store'
import { runCursorCommand } from '../chat/cursor-commands'
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
  const menuAnchor = useRef<HTMLSpanElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
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
    useAssistant.getState().seedComposer(quotePassage(view.state.doc.sliceString(range.from, range.to)))
    useUi.getState().setAssistantDock(true)
    onDone()
  }
  return (
    <div
      role="toolbar"
      aria-label={t('assistant.selection.toolbar')}
      className="fixed z-[var(--z-popover)] flex items-center gap-0.5 rounded-[var(--r-full)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-pop)]"
      style={{
        top: Math.max(8, selection.rect.top - 44),
        left: Math.max(8, Math.min(selection.rect.left, window.innerWidth - 300)),
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
      {commands.length > 0 && (
        <>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />
          <span ref={menuAnchor}>
            <Button size="sm" variant="ghost" icon={<Wand2 size={13} />} onClick={() => setMenuOpen((open) => !open)}>
              {t('assistant.cursor_commands.run')}
            </Button>
          </span>
          <Menu
            anchor={menuAnchor}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            label={t('assistant.cursor_commands.run')}
            items={commands.map((command) => ({
              id: command.id,
              label: command.label,
              onSelect: () => {
                const view = getActiveEditorView()
                if (!view || !noteId) return
                const range = view.state.selection.main
                if (range.empty) return
                runCursorCommand(command, view.state.doc.sliceString(range.from, range.to), { id: noteId, title: noteTitle })
                onDone()
              },
            }))}
          />
        </>
      )}
    </div>
  )
}
