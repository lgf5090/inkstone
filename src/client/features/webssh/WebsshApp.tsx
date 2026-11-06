import { SquareTerminal } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Badge } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { TerminalWorkspace } from './TerminalWorkspace'
import '@xterm/xterm/css/xterm.css'
import './webssh.css'

/**
 * The demo transport is the only one W4 ships; the badge is the one sentence that must never be
 * hidden, because a terminal that looks live must not be mistaken for a real SSH connection.
 */
const DEMO_TRANSPORT = true

export function WebsshApp() {
  return (
    <div
      data-testid="webssh-app-root"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <SquareTerminal size={16} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <h1 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
          {t('webssh.app.title')}
        </h1>
        {DEMO_TRANSPORT && (
          <Tooltip label={t('webssh.app.demo_hint')}>
            <Badge tone="warning">{t('webssh.app.demo_badge')}</Badge>
          </Tooltip>
        )}
        <span className="hidden min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)] md:inline">
          {t('webssh.app.demo_hint')}
        </span>
      </header>
      <TerminalWorkspace demoTransport={DEMO_TRANSPORT} />
    </div>
  )
}
