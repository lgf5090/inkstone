import { LayoutGrid, List } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { IconButton } from '../../../../components/primitives'
import type { GithubSectionView } from '../prefs'

export function ViewToggle({ value, onChange }: { value: GithubSectionView; onChange: (value: GithubSectionView) => void }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-0.5" role="group" aria-label={t('development.github.common.view_switch')}>
      <IconButton label={t('development.github.common.list_view')} size="sm" active={value === 'list'} onClick={() => onChange('list')}><List size={13} /></IconButton>
      <IconButton label={t('development.github.common.grid_view')} size="sm" active={value === 'grid'} onClick={() => onChange('grid')}><LayoutGrid size={13} /></IconButton>
    </span>
  )
}
