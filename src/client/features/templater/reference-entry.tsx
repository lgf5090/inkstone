/**
 * The button that opens the syntax reference, and nothing else.
 *
 * It lives apart from `reference-panel.tsx` on purpose: the panel carries the whole documentation table, and a
 * settings row or an editor toolbar must not be the reason that table is in the chunk the app loads first. The
 * import below is what keeps the table behind a click — `tests/templater-offline-footprint.test.ts` is the
 * sentinel if that ever stops being true.
 */
import { lazy, Suspense, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Button } from '../../components/primitives'
import { t } from '../../lib/i18n'

const TemplateReference = lazy(() => import('./reference-panel').then((module) => ({ default: module.TemplateReference })))

export function TemplateReferenceButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size={size} icon={<BookOpen size={13}/>} onClick={() => setOpen(true)}>
        {t('templater.ref.open')}
      </Button>
      {open && (
        <Suspense fallback={null}>
          <TemplateReference open onClose={() => setOpen(false)}/>
        </Suspense>
      )}
    </>
  )
}
