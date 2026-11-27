import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { LockKeyhole, ShieldCheck, UnlockKeyhole } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button, Spinner } from '../../../components/primitives'
import { Field, Input, Select } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi, setVaultUnlockToken } from '../api'
import { useCloudDriveStore } from '../store'

export function VaultPage() {
  const toast = useUi((state) => state.toast)
  const mounts = useCloudDriveStore(useShallow((state) => state.bootstrap?.mounts.filter((mount) => mount.storageId === 'primary' && mount.enabled && !mount.readOnly) ?? []))
  const [mountId, setMountId] = useState('primary')
  const [path, setPath] = useState('/Vault')
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [unlocked, setUnlocked] = useState(false)

  useEffect(() => {
    if (mounts.some((mount) => mount.id === mountId)) return
    setMountId(mounts[0]?.id ?? '')
  }, [mountId, mounts])

  const submit = async (mode: 'create' | 'unlock') => {
    setBusy(true)
    try {
      if (mode === 'create') await clouddriveApi.createVault({ mountId, path, password, currentPassword })
      else {
        const result = await clouddriveApi.unlockVault({ mountId, path, password, currentPassword })
        setVaultUnlockToken(result.token)
        setUnlocked(true)
      }
      setPassword('')
      setCurrentPassword('')
      toast({ title: mode === 'create' ? t('clouddrive.vault.created') : t('clouddrive.vault.unlocked') })
    } catch (caught) {
      setVaultUnlockToken(null)
      setUnlocked(false)
      toast({ title: t('clouddrive.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  const lock = async () => {
    setBusy(true)
    try {
      await clouddriveApi.lockVault({ mountId, path })
      setVaultUnlockToken(null)
      setUnlocked(false)
    } catch (caught) {
      toast({ title: t('clouddrive.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  const disable = async () => {
    if (!(await confirm({ title: t('clouddrive.vault.disable'), description: t('clouddrive.vault.disable_confirm'), tone: 'danger' }))) return
    setBusy(true)
    try {
      await clouddriveApi.deleteVault({ mountId, path, currentPassword })
      setVaultUnlockToken(null)
      setUnlocked(false)
      setCurrentPassword('')
      toast({ title: t('clouddrive.vault.disabled') })
    } catch (caught) {
      toast({ title: t('clouddrive.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-4">
      <div>
        <h1 className="text-[length:var(--text-15)] font-semibold">{t('clouddrive.vault.title')}</h1>
        <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('clouddrive.vault.description')}</p>
      </div>
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <div className="mb-3 flex items-center gap-2 text-[var(--accent)]">
          {unlocked ? <UnlockKeyhole size={18} /> : <LockKeyhole size={18} />}
          <span className="text-[length:var(--text-12)]">{unlocked ? t('clouddrive.vault.open') : t('clouddrive.vault.closed')}</span>
        </div>
        <div className="grid gap-2">
          <Field label={t('clouddrive.vault.mount')}>
            <Select value={mountId} onChange={(event) => setMountId(event.target.value)}>
              {mounts.map((mount) => <option key={mount.id} value={mount.id}>{mount.name}</option>)}
            </Select>
          </Field>
          <Field label={t('clouddrive.vault.path')}><Input value={path} onChange={(event) => setPath(event.target.value)} /></Field>
          <Field label={t('clouddrive.vault.password')}><Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <Field label={t('clouddrive.vault.current_password')}><Input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {busy && <Spinner size={14} />}
          <Button variant="primary" loading={busy} disabled={!mountId || !path.startsWith('/') || password.length < 8 || !currentPassword} onClick={() => void submit('unlock')}><ShieldCheck size={14} /> {t('clouddrive.vault.unlock')}</Button>
          <Button variant="secondary" loading={busy} disabled={!mountId || !path.startsWith('/') || password.length < 8 || !currentPassword} onClick={() => void submit('create')}>{t('clouddrive.vault.create')}</Button>
          {unlocked && <Button variant="ghost" loading={busy} onClick={() => void lock()}>{t('clouddrive.vault.lock')}</Button>}
          <Button variant="ghost" loading={busy} disabled={!currentPassword} onClick={() => void disable()}>{t('clouddrive.vault.disable')}</Button>
        </div>
      </div>
    </div>
  )
}
