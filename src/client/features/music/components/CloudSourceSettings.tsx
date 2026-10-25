/**
 * The three places the music app can read files from: the deployment's R2 bucket, one of the
 * account's backup WebDAV targets, and the Alist mounts.
 *
 * R2 has no account to choose and Alist keeps its own mount list; only WebDAV needs two coordinates,
 * a target and the folder inside it. The test button saves those coordinates first, so the list it
 * reads is the one the cloud page will read on its next visit.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Server, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { api } from '../../../lib/api'
import { navigateToPath } from '../../../lib/app-history'
import { isImeComposing } from '../../../lib/ime'
import { formatBytes } from '@shared/music/format'
import { Badge, Button } from '../../../components/primitives'
import { Input, SettingRow } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { SectionHeader } from './SectionHeader'
import { MusicTabs } from './Tabs'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { useMusicSettings } from '../store/settings'
import { t } from '../../../lib/i18n'

type CloudSource = 'r2' | 'webdav' | 'alist'

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ready'; files: number; folders: number; names: string[] }
  | { status: 'error'; message: string }

function key(value: string): MessageKey {
  return value as MessageKey
}

function mountAddress(baseUrl: string, rootPath: string): string {
  try {
    return new URL(rootPath.replace(/^\/+/, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
  } catch {
    return `${baseUrl}${rootPath}`
  }
}

export function CloudSourceSettings(): ReactElement {
  const [tab, setTab] = useState<CloudSource>('webdav')
  const server = useMusicSettings((state) => state.server)
  const saveServer = useMusicSettings((state) => state.saveServer)
  const flushServer = useMusicSettings((state) => state.flushServer)
  const [targetId, setTargetId] = useState(server.cloudWebdavTargetId)
  const [dir, setDir] = useState(server.cloudWebdavDir)
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  useEffect(() => {
    setTargetId(server.cloudWebdavTargetId)
    setDir(server.cloudWebdavDir)
  }, [server.cloudWebdavTargetId, server.cloudWebdavDir])

  const targets = useMusicQuery(() => api.backup.targets(), [])
  const webdavTargets = (targets.data?.targets ?? []).filter((target) => target.type === 'webdav')
  const effectiveTarget = webdavTargets.find((target) => target.id === targetId)
    ?? webdavTargets.find((target) => target.enabled)
    ?? webdavTargets[0]
    ?? null
  const selectedUrl = effectiveTarget && 'url' in effectiveTarget.config ? effectiveTarget.config.url : ''

  const drive = useMusicQuery(() => musicApi.drive(), [], { enabled: tab === 'r2' })
  const health = useMusicQuery(() => musicApi.health(), [], { enabled: tab === 'r2' })
  const mounts = useMusicQuery(() => musicApi.alistMounts(), [], { enabled: tab === 'alist' })

  const chooseTarget = (next: string): void => {
    setTargetId(next)
    setTest({ status: 'idle' })
    saveServer({ cloudWebdavTargetId: next })
  }

  const saveDir = (): void => {
    const next = dir.trim().replace(/^\/+|\/+$/g, '') || 'music'
    setDir(next)
    saveServer({ cloudWebdavDir: next })
  }

  const runTest = async (): Promise<void> => {
    if (!targetId && webdavTargets.length === 0) {
      setTest({ status: 'error', message: t(key('music.settings.cloud.test_need_account')) })
      return
    }
    setTest({ status: 'testing' })
    saveServer({ cloudWebdavTargetId: targetId, cloudWebdavDir: dir.trim() || 'music' })
    await flushServer()
    const settings = useMusicSettings.getState()
    if (settings.serverStatus === 'error') {
      setTest({ status: 'error', message: settings.serverErrorDetail ?? t(key('music.settings.cloud.test_failed')) })
      return
    }
    try {
      const listing = await musicApi.driveWebdav('')
      if (!listing.configured) {
        setTest({ status: 'error', message: listing.reason ?? t(key('music.settings.cloud.test_failed')) })
        return
      }
      const media = listing.entries.filter((entry) => !entry.isDirectory && entry.isMedia)
      const folders = listing.entries.filter((entry) => entry.isDirectory)
      setTest({
        status: 'ready',
        files: media.length,
        folders: folders.length,
        names: media.slice(0, 3).map((entry) => entry.name),
      })
    } catch (error) {
      setTest({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4">
      <SectionHeader
        title={t(key('music.settings.cloud.title'))}
        description={t(key('music.settings.cloud.description'))}
        className="pt-4"
      />
      <MusicTabs<CloudSource>
        value={tab}
        label={t(key('music.settings.cloud.tabs'))}
        onChange={setTab}
        items={[
          { value: 'r2', label: t(key('music.cloud.source.r2')) },
          { value: 'webdav', label: t(key('music.cloud.source.webdav')) },
          { value: 'alist', label: t(key('music.cloud.source.alist')) },
        ]}
      />

      {tab === 'r2' && (
        <div role="tabpanel" aria-label={t(key('music.cloud.source.r2'))} className="flex flex-col gap-3 pb-4 pt-3">
          {health.status === 'ready' && health.data && (
            <SettingRow
              title={t(key('music.settings.cloud.r2_status'))}
              description={t(key('music.settings.cloud.r2_description'))}
            >
              <Badge tone={health.data.storage === 'r2' ? 'success' : 'warning'}>
                {t(key(health.data.storage === 'r2' ? 'music.settings.cloud.r2_enabled' : 'music.settings.cloud.r2_disabled'))}
              </Badge>
            </SettingRow>
          )}
          {drive.status === 'ready' && drive.data && (
            <SettingRow title={t(key('music.settings.cloud.r2_usage'))}>
              <span className="text-[length:var(--text-12-5)] tabular-nums text-[var(--text-secondary)]">
                {t(key('music.settings.cloud.r2_usage_value'), {
                  bytes: formatBytes(drive.data.r2.bytes),
                  objects: drive.data.r2.objects,
                })}
              </span>
            </SettingRow>
          )}
          {(health.status === 'error' || drive.status === 'error') && (
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
              {health.error ?? drive.error ?? t(key('music.settings.cloud.load_failed'))}
            </p>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => navigateToPath('/music/cloud?source=r2')}>
              {t(key('music.settings.cloud.open'))}
            </Button>
          </div>
        </div>
      )}

      {tab === 'webdav' && (
        <div role="tabpanel" aria-label={t(key('music.cloud.source.webdav'))} className="flex flex-col gap-3 pb-4 pt-3">
          {targets.status === 'error' && (
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
              {targets.error ?? t(key('music.settings.cloud.targets_failed'))}
            </p>
          )}
          {targets.status === 'loading' && !targets.data && (
            <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t(key('common.loading'))}</p>
          )}
          {targets.status === 'ready' && webdavTargets.length === 0 && (
            <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2 text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
              {t(key('music.settings.cloud.no_targets'))}
            </p>
          )}
          {targets.status === 'ready' && webdavTargets.length > 0 && (
            <>
              <SettingRow
                title={t(key('music.settings.cloud.webdav_account'))}
                description={selectedUrl
                  ? t(key('music.settings.cloud.webdav_account_url'), { url: selectedUrl })
                  : t(key('music.settings.cloud.webdav_account_hint'))}
              >
                <SelectMenu
                  label={t(key('music.settings.cloud.webdav_account'))}
                  value={targetId}
                  options={[
                    { value: '', label: t(key('music.settings.cloud.webdav_auto')) },
                    ...webdavTargets.map((target) => ({ value: target.id, label: target.name })),
                    ...(targetId && !webdavTargets.some((target) => target.id === targetId)
                      ? [{ value: targetId, label: t(key('music.settings.cloud.webdav_missing')) }]
                      : []),
                  ]}
                  onChange={chooseTarget}
                  width={260}
                />
              </SettingRow>
              <SettingRow
                title={t(key('music.settings.cloud.webdav_dir'))}
                description={t(key('music.settings.cloud.webdav_dir_hint'))}
              >
                <Input
                  value={dir}
                  maxLength={512}
                  placeholder="music"
                  aria-label={t(key('music.settings.cloud.webdav_dir'))}
                  onChange={(event) => {
                    setDir(event.target.value)
                    setTest({ status: 'idle' })
                  }}
                  onBlur={saveDir}
                  onKeyDown={(event) => {
                    if (isImeComposing(event)) return
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      saveDir()
                    }
                  }}
                />
              </SettingRow>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => navigateToPath('/music/cloud?source=webdav')}>
                  {t(key('music.settings.cloud.open'))}
                </Button>
                <Button size="sm" variant="primary" loading={test.status === 'testing'} onClick={() => { void runTest() }}>
                  {t(key('music.settings.cloud.test'))}
                </Button>
              </div>
            </>
          )}
          {test.status === 'testing' && (
            <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t(key('music.settings.cloud.testing'))}
            </p>
          )}
          {test.status === 'ready' && (
            <div role="status" className="rounded-[var(--r-md)] border border-[var(--success)]/25 bg-[var(--success)]/8 px-3 py-2 text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
              <p className="flex items-center gap-1.5 font-medium text-[var(--success)]">
                <ShieldCheck size={14} aria-hidden="true" />
                {test.files > 0
                  ? t(key('music.settings.cloud.test_ok'), { files: test.files, folders: test.folders })
                  : t(key('music.settings.cloud.test_empty'), { folders: test.folders })}
              </p>
              {test.names.length > 0 && (
                <p className="mt-1 truncate text-[var(--text-tertiary)]">
                  {t(key('music.settings.cloud.test_names'), { names: test.names.join(', ') })}
                </p>
              )}
            </div>
          )}
          {test.status === 'error' && (
            <p role="alert" className="flex items-start gap-1.5 rounded-[var(--r-md)] bg-[var(--danger)]/8 px-3 py-2 text-[length:var(--text-12)] leading-relaxed text-[var(--danger)]">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              {test.message}
            </p>
          )}
        </div>
      )}

      {tab === 'alist' && (
        <div role="tabpanel" aria-label={t(key('music.cloud.source.alist'))} className="flex flex-col gap-3 pb-4 pt-3">
          <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
            {t(key('music.settings.cloud.alist_description'))}
          </p>
          {mounts.status === 'error' && (
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
              {mounts.error ?? t(key('music.settings.cloud.load_failed'))}
            </p>
          )}
          {mounts.status === 'loading' && !mounts.data && (
            <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t(key('common.loading'))}</p>
          )}
          {mounts.status === 'ready' && mounts.data && mounts.data.mounts.length === 0 && (
            <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2 text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
              {t(key('music.settings.cloud.no_alist'))}
            </p>
          )}
          {mounts.status === 'ready' && mounts.data && mounts.data.mounts.length > 0 && (
            <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
              {mounts.data.mounts.map((mount) => (
                <li key={mount.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
                  <Server size={15} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{mount.name}</span>
                    <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{mountAddress(mount.baseUrl, mount.rootPath)}</span>
                  </span>
                  <Badge tone={mount.status === 'active' ? 'success' : 'warning'}>
                    {t(key(mount.status === 'active' ? 'music.settings.cloud.alist_active' : 'music.settings.cloud.alist_error'))}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => navigateToPath('/music/cloud?source=alist')}>
              {t(key('music.settings.cloud.manage_alist'))}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
