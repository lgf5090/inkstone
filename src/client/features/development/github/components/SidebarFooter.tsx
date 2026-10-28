import { Globe, KeyRound } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'

export function SidebarFooter({
  onOpenAccounts,
  onOpenMirrors,
  currentMirrorName,
}: {
  onOpenAccounts: () => void
  onOpenMirrors: () => void
  currentMirrorName?: string
}) {
  return (
    <div className="grid grid-cols-2 gap-1 p-2" data-slot="sidebar-footer-actions">
      <Button
        variant="secondary"
        className="h-auto flex-col gap-1 px-1 py-2 md:h-auto"
        icon={<KeyRound size={14} />}
        onClick={onOpenAccounts}
      >
        <span className="w-full truncate text-center text-[length:var(--text-11)] leading-none">
          {t('development.github.accounts.manage')}
        </span>
      </Button>
      <Button
        variant="secondary"
        className="h-auto flex-col gap-1 px-1 py-2 md:h-auto"
        icon={<Globe size={14} />}
        onClick={onOpenMirrors}
      >
        <span className="w-full truncate text-center text-[length:var(--text-11)] leading-none">
          {currentMirrorName
            ? t('development.github.mirrors.current', { name: currentMirrorName })
            : t('development.github.mirrors.manage')}
        </span>
      </Button>
    </div>
  )
}
