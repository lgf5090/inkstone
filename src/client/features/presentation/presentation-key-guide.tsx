import { X } from 'lucide-react'
import { IconButton, Kbd } from '../../components/primitives'
import { t } from '../../lib/i18n'
import { presentationKeyReference } from './presentation-keys'

// Where the show's bindings can be looked up, opened by `?` and by the right-click row that names it.
// It is a layer of the projector rather than a row of the capsule: a panel that grew the toolbar pushes
// the button the presenter just pressed out from under the pointer, which is the rule the mind map's
// keyboard reference follows, and a layer held beside the dialog would sit under the slide it explains.
export function PresentationKeyGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <section data-presentation-key-guide className='presentation-key-guide' aria-label={t('workspace.presentation_keys')}>
      <header className='mb-[var(--sp-2)] flex items-center justify-between gap-[var(--sp-3)]'>
        <h2 className='text-[length:var(--text-13)] font-semibold tracking-[var(--tracking-section)] text-[var(--text-primary)]'>{t('workspace.presentation_keys')}</h2>
        <IconButton label={t('common.close')} size='sm' onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>
      <ul>
        {presentationKeyReference().map((row) => (
          <li key={row.command}>
            <span>{row.description}</span>
            <Kbd keys={row.caps} />
          </li>
        ))}
      </ul>
    </section>
  )
}
