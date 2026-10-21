import type { ReactElement } from 'react'
import { StickyNote } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Empty } from '../../components/feedback'
import { MEMOS_MESSAGE_KEYS } from '@shared/memos/keys'
import type { MemoPublicView } from './public-route'

export function MemosPublicApp({ route }: { route: MemoPublicView }): ReactElement {
  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-memos-public={route.kind}>
      <header data-print="hide" className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <StickyNote size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <h1 className="min-w-0 shrink truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
          {t(MEMOS_MESSAGE_KEYS.appTab)}
        </h1>
      </header>
      <main className="min-h-0 flex-1">
        <Empty title={t(MEMOS_MESSAGE_KEYS.empty)} />
      </main>
    </section>
  )
}
