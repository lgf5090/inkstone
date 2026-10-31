import { useState } from 'react'
import { Download } from 'lucide-react'
import type { GithubRepo } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { githubApi } from '../api'
import { parseRepoInput } from '../routes'
import { Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'

export function RepoImportDialog({ open, onClose, onImport }: { open: boolean; onClose: () => void; onImport: (repo: GithubRepo) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const importRepo = async () => {
    const fullName = parseRepoInput(value)
    if (!fullName) {
      setError(t('development.github.repos.import_invalid'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const repo = await githubApi.repoLookup(fullName)
      onImport(repo)
      setValue('')
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('development.github.repos.import_failed'))
    } finally {
      setLoading(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<span className="inline-flex items-center gap-2"><Download size={15} />{t('development.github.repos.import_title')}</span>}
      description={t('development.github.repos.import_desc')}
      width={520}
      footer={<><Button variant="secondary" onClick={onClose} disabled={loading}>{t('common.cancel')}</Button><Button onClick={() => void importRepo()} disabled={loading || !value.trim()} loading={loading}><Download size={13} />{loading ? t('development.github.repos.importing') : t('development.github.repos.import_repo')}</Button></>}
    >
      <div className="space-y-2">
        <Input value={value} onChange={(event) => { setValue(event.target.value); setError(null) }} placeholder={t('development.github.repos.import_placeholder')} onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter' && value.trim() && !loading) { event.preventDefault(); void importRepo() } }} autoFocus />
        {error && <p className="text-[length:var(--text-11)] text-[var(--danger)]" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
