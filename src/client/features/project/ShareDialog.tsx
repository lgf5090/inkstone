import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ProjectShare } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { deleteProjectShare, getProjectShare, putProjectShare } from './api'

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export function ShareDialog({ boardId, onClose }: { boardId: string, onClose: () => void }): ReactElement {
  const [share, setShare] = useState<ProjectShare | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [password, setPassword] = useState('')
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    getProjectShare(boardId)
      .then((result) => { setShare(result); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [boardId])

  const guard = useCallback(async (action: () => Promise<void>) => {
    try { await action() } catch (reason) { toast({ title: errorText(reason), tone: 'danger' }) }
  }, [toast])

  const link = share ? `${window.location.origin}/p/${share.slug}` : ''

  return (
    <Modal open onClose={onClose} title={t('project.share.title')} width={480}>
      {!loaded
        ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">…</p>
        : !share
          ? (
              <div className="space-y-3">
                <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('project.share.not_shared')}</p>
                <Button variant="primary" onClick={() => void guard(async () => { setShare(await putProjectShare(boardId, {})) })}>{t('project.share.enable')}</Button>
              </div>
            )
          : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Input className="min-w-0 flex-1" readOnly value={link} aria-label={t('project.share.link')} />
                  <Button size="sm" onClick={() => { void navigator.clipboard.writeText(link).then(() => toast({ title: t('project.share.copy'), tone: 'success' })) }}>{t('project.share.copy')}</Button>
                </div>
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.share.views', { count: share.views })}</p>
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void guard(async () => { setShare(await putProjectShare(boardId, { password: password || null })); setPassword('') })
                  }}
                >
                  <Input className="min-w-0 flex-1" type="password" value={password} placeholder={t('project.share.password')} aria-label={t('project.share.password')} onChange={(event) => setPassword(event.target.value)} />
                  <Button type="submit" size="sm">{t('common.save')}</Button>
                </form>
                <Button variant="danger" size="sm" onClick={() => void guard(async () => { await deleteProjectShare(boardId); setShare(null) })}>{t('project.share.disable')}</Button>
              </div>
            )}
    </Modal>
  )
}