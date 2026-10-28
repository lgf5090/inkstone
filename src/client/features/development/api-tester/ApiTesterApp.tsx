import { Send } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { useBreakpoint } from '../../../lib/hooks'
import { Empty } from '../../../components/feedback'
import { Button } from '../../../components/primitives'

export function ApiTesterApp() {
  const breakpoint = useBreakpoint()
  return (
    <div
      data-testid="api-tester-app-root"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        <Send size={16} className="shrink-0 text-[var(--accent)]" />
        <span className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
          {t('development.apitester.module_name')}
        </span>
        <span className="rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('development.apitester.app.relay')}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty
          title={t('development.apitester.app.empty_title')}
          description={t('development.apitester.app.empty_hint')}
          action={
            <Button size="sm" disabled>
              {t('development.apitester.app.new_rest')}
            </Button>
          }
        />
      </div>
      <span className="sr-only" data-breakpoint={breakpoint} />
    </div>
  )
}
