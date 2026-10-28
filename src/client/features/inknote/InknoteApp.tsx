import { NotebookPen } from 'lucide-react'
import { useLocale } from '../../lib/i18n'

export function InknoteApp() {
  useLocale()
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-[var(--bg-base)] text-[var(--text-secondary)]">
      <NotebookPen size={28} aria-hidden="true" />
      <p className="text-[length:var(--text-14)]">Inknote</p>
    </div>
  )
}
