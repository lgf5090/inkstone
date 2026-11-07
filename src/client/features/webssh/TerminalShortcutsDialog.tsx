import { Modal } from '../../components/overlay'
import { Kbd, Button, Badge } from '../../components/primitives'
import { t } from '../../lib/i18n'

const SHORTCUTS = [
  { id: 'copy', combo: 'mod+shift+c', labelKey: 'webssh.shortcuts.copy' },
  { id: 'paste', combo: 'mod+shift+v', labelKey: 'webssh.shortcuts.paste' },
  { id: 'clear', combo: 'mod+shift+k', labelKey: 'webssh.shortcuts.clear' },
] as const

export function TerminalShortcutsDialog({ open, onClose, demo }: { open: boolean; onClose: () => void; demo: boolean }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.shortcuts.title')}
      description={t('webssh.shortcuts.description')}
      width={480}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.id} className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{t(shortcut.labelKey)}</span>
            <Kbd combo={shortcut.combo} />
          </div>
        ))}
        <div className="flex items-center justify-between gap-3">
          <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{t('webssh.shortcuts.switch_tab')}</span>
          <Kbd keys={['←', '→']} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{t('webssh.shortcuts.tab_focus')}</span>
          <Kbd keys={['Tab']} />
        </div>
        <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">{t('webssh.shortcuts.ctrl_c')}</p>
        {demo && (
          <div className="flex items-start gap-2 rounded-[var(--r-md)] bg-[var(--warning-softer)] p-2.5">
            <Badge tone="warning">{t('webssh.app.demo_badge')}</Badge>
            <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]">{t('webssh.shortcuts.demo_note')}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
