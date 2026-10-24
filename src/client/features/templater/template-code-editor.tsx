/**
 * The template library's body editor: a code editor for Templater text.
 *
 * A template body is code the reader is writing, and the `<textarea>` it lived in could not say where the
 * prose stops and the command starts, could not offer the `tp.` names the registry already documents, and
 * had no line numbers to navigate a parse error by. This is CodeMirror with the two extensions the note
 * editor was given today — `editor/templater.ts` for the marks and `editor/templater-completion.ts` for the
 * suggestions, both reused rather than re-implemented — mounted as its own small view.
 *
 * It is deliberately not `editor/CodeEditor`. That component is a *note* editor, and both halves of that
 * are load-bearing here: it registers its view as the app's active editor, which is exactly what
 * `features/templater/editor-surface.ts` reads to decide where a run's text and caret go — a dialog open
 * over a note would move those to the dialog; and it is built around a note's own `onChange`, paste
 * handlers, dragger, outliner, hover cards and wiki-link/tag/emoji completion sources, none of which a
 * template body has. A body is text the reader is writing, not a note they are in.
 *
 * What the surface owes the dialog it sits in, all of it pinned by `template-code-editor.test.ts`:
 *
 * - Escape closes the dialog. The dialog answers Escape first, because `useEscape` listens on the window in
 *   the capture phase, so the editor's job is to stay out of the way — except while a suggestion list is
 *   open, where Escape means "put that away" and closing the dialog would throw away the draft with it.
 * - Tab leaves the editor. It takes a suggestion when one is offered, and is left alone otherwise, which is
 *   why `indentWithTab` is not installed.
 * - An input method keeps its keystrokes: no React key handler here, and the one command binding asks
 *   `view.composing` first, because CodeMirror's keymap does not.
 * - The editable element carries the name and description the dialog's `Field` gives it.
 * - Undo works, as it did in the textarea.
 *
 * Focus is not taken on purpose: the dialog puts it in the template's name, and that is where it stays.
 */
import { useEffect, useRef, useState } from 'react'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
} from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { templaterHighlight } from '../../editor/templater'
import { templaterCompletion } from '../../editor/templater-completion'
import { templaterUserScripts } from './script-completion'
import { useSession } from '../../store/session'
import { describeTemplateBody, type TemplateBodyReport } from './template-body-check'
import { TemplateReferenceButton } from './reference-entry'

/** A change this component dispatched to follow its own `value`, which is not the reader typing. */
const externalValue = Annotation.define<boolean>()

/**
 * The room the editor gets: the same box the gallery's read-only preview of a body takes, which is about
 * what the sixteen-row textarea this replaced was.
 *
 * A definite height rather than a maximum, because CodeMirror scrolls inside its own container and needs
 * one to be told: with a maximum the text past the bottom is clipped and unreachable, and the line numbers
 * scroll away with the dialog instead of staying beside the lines they count.
 */
const EDITOR_BOX = 'h-[min(46vh,420px)] min-h-70'

export interface TemplateCodeEditorProps {
  value: string
  /**
   * The body as it now reads.
   *
   * A string rather than the input event a `<textarea>` handed over: this is a component, and the dialog
   * keeps its own draft.
   */
  onChange: (value: string) => void
  /** The dialog rejected this body. Same two effects as `Input`'s prop of the same name. */
  invalid?: boolean
  className?: string
  /**
   * The name and description `Field` clones onto the control it wraps.
   *
   * A CodeMirror surface has no element of its own to receive them, so they are carried to its editable
   * element — the one a screen reader lands on.
   */
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-required'?: boolean | 'true' | 'false'
}

/**
 * The dialog's names for this control, in the form CodeMirror writes onto `contenteditable`.
 *
 * Entries with nothing in them are left out rather than passed along: whatever is given becomes an
 * attribute, so an `aria-label` of `undefined` would be a name a reader is told.
 */
function editableAttributes(props: TemplateCodeEditorProps): Record<string, string> {
  const wanted: [string, string | boolean | undefined][] = [
    ['id', props.id],
    ['aria-label', props['aria-label']],
    ['aria-labelledby', props['aria-labelledby']],
    ['aria-describedby', props['aria-describedby']],
    ['aria-required', props['aria-required']],
    ['aria-invalid', props.invalid ? true : undefined],
  ]
  const attributes: Record<string, string> = {}
  for (const [name, value] of wanted) {
    if (value === undefined || value === false) continue
    attributes[name] = String(value)
  }
  return attributes
}

export function TemplateCodeEditor(props: TemplateCodeEditorProps) {
  const { value, onChange, invalid, className } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const attributesCompartment = useRef(new Compartment())
  const [report, setReport] = useState<TemplateBodyReport | null>(null)
  // The reader's own documentation depth, read when a list is asked for rather than baked into the
  // extension, so a change in the settings panel lands on the next keystroke.
  const intellisenseRender = useSession((state) => state.settings.templater.intellisenseRender)
  const latest = useRef({ value, onChange, intellisenseRender })
  latest.current = { value, onChange, intellisenseRender }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      // The body is the note it will become, so the Markdown language goes in — and not only for the prose:
      // `templaterHighlight` reads the syntax tree to leave a command inside a fenced block unmarked.
      markdown({ base: markdownLanguage, addKeymap: false }),
      // Always on here. The note editor's switch keeps prose clean of marks a reader who writes notes, not
      // templates, has no use for; in a template body the command is the thing being looked at.
      templaterHighlight({ enabled: () => true }),
      // A template's own parentheses are the ones a completion is about to fill in, and the completion's
      // `apply` adopts a paired `(` rather than writing a second one.
      closeBrackets(),
      autocompletion({
        // Only the Templater source: the note editor's wiki-link, tag, emoji, task and fence sources all
        // answer from a note, a library of them, or the caret inside one, and this body has none of that.
        override: [templaterCompletion({
          intellisenseRender: () => latest.current.intellisenseRender,
          userScripts: templaterUserScripts,
          // The body being edited is the reader's own, which is the profile a run of it would get
          // (`features/templater/run-shell.ts`), so the documentation panel can say what a run may refuse.
          profile: () => 'local',
        })],
        activateOnTyping: true,
        closeOnBlur: true,
        maxRenderedOptions: 24,
        icons: false,
      }),
      attributesCompartment.current.of(EditorView.contentAttributes.of(editableAttributes(props))),
      keymap.of([
        {
          // Tab takes the suggestion the reader is looking at and otherwise does nothing, which is how the
          // keystroke stays the browser's and leaves the editor. Asking `view.composing` first is the part
          // CodeMirror does not do for you: an input method binds Tab to its own candidate list, and a key
          // still assembling a word belongs to it, not to this command. The note editor's own Tab binding
          // asks nothing, so this is the stricter of the two — and `view.composing` is the public signal,
          // which only turns on after the first composed character, so the very first Tab of a composition
          // is a window this does not close. Closing it means the composition watcher the outliner wrote
          // for exactly that gap, and a second copy of one plugin is not a trade worth making here.
          key: 'Tab',
          run: (view) => !view.composing && acceptCompletion(view),
        },
      ]),
      // `historyKeymap` is the undo the textarea gave for free; `defaultKeymap` holds no Tab binding, which
      // is why `indentWithTab` is left out of the set.
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.transactions.length > 0) {
          // Escape is the dialog's while no suggestion list is open, and the editor's while one is.
          // `useEscape` already stands aside for a keystroke that comes from inside `[data-owns-escape]`,
          // so marking the editor when a list is up is the whole of the handover — and it is what stops the
          // keystroke that hides a popup from also throwing away the draft under it.
          const ownsEscape = completionStatus(update.view.state) === 'active'
          if (ownsEscape !== update.view.contentDOM.hasAttribute('data-owns-escape')) {
            if (ownsEscape) update.view.contentDOM.setAttribute('data-owns-escape', 'true')
            else update.view.contentDOM.removeAttribute('data-owns-escape')
          }
        }
        if (!update.docChanged) return
        if (update.transactions.some((transaction) => transaction.annotation(externalValue))) return
        latest.current.onChange(update.state.doc.toString())
      }),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: latest.current.value, extensions }),
      parent: host,
    })
    // The body is code: the spellcheck red underline the reader's notes get would only be noise on a
    // function name, and this is what the textarea this replaced was set to.
    view.contentDOM.spellcheck = false
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // The dialog owns the text, so a `value` that is not what the editor holds is put in without being
  // reported back as a keystroke.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
      annotations: externalValue.of(true),
    })
  }, [value])

  const attributesKey = JSON.stringify(editableAttributes(props))
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: attributesCompartment.current.reconfigure(EditorView.contentAttributes.of(editableAttributes(props))) })
    // `attributesKey` is the props object read down to the only entries that reach the DOM.
  }, [attributesKey])

  // A report is an answer about the text it was made from, so editing that text retires the answer instead
  // of leaving a verdict beside words that have since changed.
  useEffect(() => { setReport(null) }, [value])

  return (<>
    <div className={cn(
      'overflow-hidden rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)]',
      invalid && 'border-[var(--danger)]',
      EDITOR_BOX,
      className,
    )}>
      {/* The note editor's chrome, with the prose-only parts taken back out — see `.ink-template-editor`
          in `styles/editor.css`. */}
      <div ref={hostRef} className='ink-editor ink-template-editor'/>
    </div>
    <div className='flex flex-wrap items-center gap-2 pt-1.5'>
      <Button size='sm' variant='ghost' onClick={() => setReport(describeTemplateBody(value))}>{t('templater.editor.check_label')}</Button>
      <TemplateReferenceButton/>
    </div>
    {report && <TemplateBodyReportView report={report}/>}
  </>)
}

/**
 * What the engine read, shown as the reader's own text.
 *
 * The rows are the commands as written and the position the parse stopped at, because that is all a check
 * that ran nothing can honestly offer; `template-body-check.ts` says why running it here is not the answer.
 * The position is written `line:column`, which is the language-neutral form the engine's own failures
 * carry, so the numbers need no catalog entry to be readable.
 */
function TemplateBodyReportView({ report }: { report: TemplateBodyReport }) {
  const { failure } = report
  return (<div role='status' className='mt-1.5 space-y-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5'>
    <p className='text-[length:var(--text-11)] text-[var(--text-tertiary)]'>{t('templater.editor.check_not_run')}</p>
    {failure && (<p className='text-[length:var(--text-11-5)] text-[var(--danger)]'>
      {t(failure.code === 'parse-unclosed' ? 'templater.error.parse_unclosed' : 'templater.error.parse_invalid')}
      <span className='font-mono'> · {failure.line}:{failure.column}</span>
    </p>)}
    {!failure && report.commands.length === 0 && (
      <p className='text-[length:var(--text-11-5)] text-[var(--text-secondary)]'>{t('templater.editor.check_none')}</p>
    )}
    {!failure && report.commands.length > 0 && (<ul className='space-y-0.5 overflow-x-auto'>
      {report.commands.map((command, index) => (<li key={`${command.line}-${index}`} className='whitespace-pre text-[length:var(--text-11-5)] font-mono text-[var(--text-secondary)]'>
        <span className='text-[var(--text-quaternary)]'>{command.line}:</span>
        {' '}
        {command.text}
      </li>))}
      {/* The list is the first `MAX_LISTED_COMMANDS` of the body's commands, so the cut is said rather than
          left implied — with the number of what is missing, because "…" alone does not tell a reader how far
          to look. */}
      {report.total > report.commands.length && (
        <li className='text-[length:var(--text-11-5)] text-[var(--text-quaternary)]'>{t('templater.editor.check_more_value0', { value0: report.total - report.commands.length })}</li>
      )}
    </ul>)}
    {/* The rows are lines of the reader's own text and nothing was rendered, which is what this caption says
        in both languages. Its number counts the commands the body holds, not the rows on screen. */}
    {!failure && report.total > 0 && (
      <p className='text-[length:var(--text-11)] text-[var(--text-quaternary)]'>{t('templater.editor.check_commands_value0', { value0: report.total })}</p>
    )}
  </div>)
}
