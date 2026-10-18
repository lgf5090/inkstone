/**
 * A draft, drawn as the document it is meant to become.
 *
 * The canvas panel edits Markdown in CodeMirror and reads it back through the notebook's own renderer,
 * which is the only thing in the app that gives a fence its highlight and its copy button, a table its
 * wrapper, a diagram its picture and a `![[note]]` its body. This module is the read-only half of that
 * pair: it hands the body to `MarkdownBody`, says plainly when the render cannot be had at all and shows
 * the text instead, and keeps out of the drawn document every control that would edit it.
 *
 * Two of those halves were not the renderer's business to decide, which is why they live here. A draft
 * has no note of its own until it is filed as one, so the embed pass needs the draft body and title
 * passed to it explicitly; left out, every `![[...]]` in an assistant's draft sat at "Loading" forever,
 * which reads as a document still arriving rather than a surface that never asked. And a task checkbox
 * comes out of the renderer as a live input, because the note preview answers a click by writing the
 * line it came from - a draft preview has no such line, so the box would flip on a press, change
 * nothing, and say it had edited the draft.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { t } from '../../lib/i18n'
import { MarkdownBody } from '../preview/MarkdownBody'
import { CHAT_NOTE_LINKS } from './note-links'

/**
 * What a drawn draft may hold: the document, with no live control in it.
 *
 * The renderer materializes a task's checkbox after sanitization, so the only place a surface can take it
 * back to inert is its own markup pass - the same door the public share page uses for the same reason.
 * `data-task-line` goes with it: that attribute is how a surface that *can* write finds the line to
 * write, and leaving it on a disabled box would advertise a target nothing here should touch.
 */
function readOnlyDraftMarkup(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const task of template.content.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) {
    task.disabled = true
    task.removeAttribute('data-task-line')
    task.setAttribute('aria-label', t('assistant.canvas.tasks_read_only'))
  }
  return template.innerHTML
}

/**
 * The draft's body, drawn.
 *
 * `title` is what makes a self-embed - `![[#A heading]]`, or the draft's own name - resolve to the text
 * the reader is looking at rather than to a note that happens to share it.
 */
export function ArtifactBody({ content, title }: { content: string, title: string }) {
  return (
    <PreviewBoundary source={content}>
      <div className="h-full overflow-y-auto px-3 py-2">
        <MarkdownBody
          source={content}
          className="ink-chat-prose min-w-0"
          links={CHAT_NOTE_LINKS}
          embeds={{ content, title }}
          transformHtml={readOnlyDraftMarkup}
        />
      </div>
    </PreviewBoundary>
  )
}

/**
 * The notice a failed render owes the reader, and the text under it.
 *
 * `MarkdownBody` builds its markup while it renders, so a document the renderer chokes on is a render
 * error rather than a return value. A panel that goes white on that is indistinguishable from a draft
 * that is empty, and an assistant draft is never empty when the reader is looking at it - so the text
 * they came to read stays on screen, under a sentence that says it was not drawn. The boundary resets
 * when the body changes: a reader who fixes the Markdown that broke the render should see the fix
 * without closing the panel.
 */
class PreviewBoundary extends Component<{ source: string, children: ReactNode }, { failed: boolean }> {
  state: { failed: boolean } = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Not a silent downgrade: what failed has to reach the console with the document it failed on, or the
    // reader's report of a blank draft has nothing to be traced to.
    console.error('[inkstone] canvas draft preview failed', error, info.componentStack)
  }

  componentDidUpdate(previous: { source: string }): void {
    if (previous.source !== this.props.source && this.state.failed) this.setState({ failed: false })
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 px-3 py-2">
        <p role="alert" className="flex shrink-0 items-start gap-1.5 text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
          <TriangleAlert size={13} className="mt-px shrink-0 text-[var(--warning)]" aria-hidden="true" />
          <span>{t('assistant.canvas.render_failed')}</span>
        </p>
        <pre
          role="region"
          aria-label={t('assistant.canvas.raw_text')}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] bg-[var(--bg-inset)] p-2 font-mono text-[length:var(--text-12)] leading-[var(--code-line)] text-[var(--text-primary)]"
        >
          {this.props.source}
        </pre>
      </div>
    )
  }
}
