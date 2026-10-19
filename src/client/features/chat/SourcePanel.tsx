/**
 * The pages and notes an answer was built on, as a readable list.
 *
 * The chips under the answer are the quick way to one source; this panel is what a reader opens when
 * they want to see what each source actually said. It only shows what the turn stored — no request is
 * made, and a source without an excerpt says so by simply having none.
 */
import { ExternalLink, FileText } from 'lucide-react'
import { isSourceUrl, type AssistantSource } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { Drawer } from '../../components/overlay'
import { openCitedNote } from './note-links'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    // The value is stored text; a source written by an older build may not parse. Showing the raw string
    // is still more useful than hiding the row.
    return url
  }
}

export function SourcePanel({ sources, onClose }: { sources: readonly AssistantSource[], onClose: () => void }) {
  return (
    <Drawer open onClose={onClose} side="right" width={460} title={t('assistant.chat.sources')}>
      <p className="px-3 pt-2 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
        {t('assistant.chat.sources_hint')}
      </p>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
        {sources.map((source, index) => {
          const note = source.kind === 'note' && source.id
          return (
            <li key={source.id ?? source.url} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 shrink-0 tabular text-[length:var(--text-11)] text-[var(--text-quaternary)]">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  {note ? (
                    <button
                      type="button"
                      onClick={() => {
                        openCitedNote(source.id!)
                        onClose()
                      }}
                      className="flex min-w-0 items-center gap-1 text-left text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)] hover:text-[var(--accent)]"
                    >
                      <FileText size={12} className="shrink-0 text-[var(--text-quaternary)]" />
                      <span className="min-w-0 truncate">{source.title || t('common.untitled_note')}</span>
                    </button>
                  ) : isSourceUrl(source.url) ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex min-w-0 items-center gap-1 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)] hover:text-[var(--accent)]"
                    >
                      <span className="min-w-0 truncate">{source.title || source.url}</span>
                      <ExternalLink size={11} className="shrink-0 opacity-70" />
                    </a>
                  ) : (
                    <span className="block truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{source.title}</span>
                  )}
                  <p className="mt-0.5 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                    {note ? t('assistant.chat.source_note') : hostOf(source.url)}
                  </p>
                  {source.cited ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
                      {source.cited}
                    </p>
                  ) : null}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </Drawer>
  )
}
