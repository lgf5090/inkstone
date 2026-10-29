/** Welcome, shortcuts and the gesture cheat sheet. */
import { listHotkeys, prettyCombo } from '../../../lib/hotkeys'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'

const GESTURES = [
  'inknote.help.gesture.undo',
  'inknote.help.gesture.redo',
  'inknote.help.gesture.zoom',
  'inknote.help.gesture.swipe',
  'inknote.help.gesture.autosave',
] as const

export function WelcomeDialog({ open, onClose, onStart }: { open: boolean; onClose: () => void; onStart: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={t('inknote.welcome.title')} width={440}>
      <div className="space-y-3">
        <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('inknote.welcome.body')}</p>
        <ul className="space-y-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {GESTURES.map((key) => <li key={key}>· {t(key)}</li>)}
        </ul>
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={onStart}>{t('inknote.welcome.start')}</Button>
        </div>
      </div>
    </Modal>
  )
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hotkeys = listHotkeys()
  return (
    <Modal open={open} onClose={onClose} title={t('inknote.help.shortcuts')} width={520}>
      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-label={t('inknote.help.keyboard')}>
          <h3 className="mb-1 text-[length:var(--text-11)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('inknote.help.keyboard')}</h3>
          <dl className="space-y-1 text-[length:var(--text-12)]">
            {hotkeys.map((hotkey) => (
              <div key={hotkey.id} className="flex items-baseline justify-between gap-2">
                <dt className="truncate">{typeof hotkey.description === 'function' ? hotkey.description() : hotkey.description}</dt>
                <dd className="shrink-0 font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{prettyCombo(hotkey.combo).join(' ')}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-label={t('inknote.help.gestures')}>
          <h3 className="mb-1 text-[length:var(--text-11)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('inknote.help.gestures')}</h3>
          <ul className="space-y-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {GESTURES.map((key) => <li key={key}>· {t(key)}</li>)}
          </ul>
        </section>
      </div>
    </Modal>
  )
}
