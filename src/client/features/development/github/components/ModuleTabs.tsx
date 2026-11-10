import { Code2, Store } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { Segmented } from '../../../../components/form'
import { GithubIcon } from './GithubIcon'

export type GithubTab = 'repos' | 'gists' | 'store'

export function ModuleTabs({ value, onChange }: { value: GithubTab; onChange: (value: GithubTab) => void }) {
  return (
    <Segmented
      value={value}
      onChange={onChange}
      className="w-full"
      label={t('development.github.module_name')}
      options={[
        {
          value: 'repos',
          label: (
            <span className="inline-flex items-center gap-1.5">
              <GithubIcon className="size-3.5" />
              {t('development.github.tabs.repos')}
            </span>
          ),
        },
        {
          value: 'gists',
          label: (
            <span className="inline-flex items-center gap-1.5">
              <Code2 size={14} />
              {t('development.github.tabs.gists')}
            </span>
          ),
        },
        {
          value: 'store',
          label: (
            <span className="inline-flex items-center gap-1.5">
              <Store size={14} />
              {t('development.github.tabs.store')}
            </span>
          ),
        },
      ]}
    />
  )
}
