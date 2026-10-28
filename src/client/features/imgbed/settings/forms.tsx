import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Button } from '../../../components/primitives'
import { Checkbox, Field, Input, Select, Switch, Textarea } from '../../../components/form'
import { LoadingBlock } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { imgbedApi } from '../api'
import type {
  ImgbedAiSettings,
  ImgbedOthersSettings,
  ImgbedPageSettings,
  ImgbedSecuritySettings,
  ImgbedUploadSettings,
} from '@shared/imgbed/settings'

type Group = 'page' | 'upload' | 'security' | 'others' | 'ai'

function useGroup<T>(group: Group): {
  value: T | null
  setValue: (next: T) => void
  loaded: boolean
  saving: boolean
  save: (next?: T) => Promise<void>
  extra: Record<string, unknown>
} {
  const [value, setValue] = useState<T | null>(null)
  const [extra, setExtra] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const toast = useUi((state) => state.toast)
  useEffect(() => {
    imgbedApi<{ value: T } & Record<string, unknown>>(`/api/imgbed/settings/${group}`)
      .then((result) => { setValue(result.value); setExtra(result as unknown as Record<string, unknown>) })
      .catch((error: Error) => toast({ title: error.message, tone: 'danger' }))
  }, [group])
  const save = async (next?: T): Promise<void> => {
    const payload = next ?? value
    if (!payload) return
    setSaving(true)
    try {
      await imgbedApi(`/api/imgbed/settings/${group}`, { method: 'PUT', body: payload })
      toast({ title: t('imgbed.settings.saved'), tone: 'success' })
    } catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
    finally { setSaving(false) }
  }
  return { value, setValue, loaded: value !== null, saving, save, extra }
}

function SaveRow({ saving, save }: { saving: boolean; save: () => Promise<void> }): ReactElement {
  return <div className="flex justify-end"><Button loading={saving} onClick={() => void save()}>{t('imgbed.settings.save')}</Button></div>
}

function Panel({ children }: { children: ReactNode }): ReactElement {
  return <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">{children}</div>
}

export function PageSettingsForm(): ReactElement {
  const { value, setValue, loaded, saving, save } = useGroup<ImgbedPageSettings>('page')
  if (!loaded || !value) return <LoadingBlock label={t('imgbed.common.loading')} />
  const set = <K extends keyof ImgbedPageSettings>(key: K, next: ImgbedPageSettings[K]): void => setValue({ ...value, [key]: next })
  return (
    <Panel>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('imgbed.settings.announcement' as never)} className="md:col-span-2"><Textarea value={value.announcement} onChange={(event) => set('announcement', event.target.value)} rows={4} /></Field>
        <Field label={t('imgbed.settings.url_prefix' as never)}><Input value={value.urlPrefix} onChange={(event) => set('urlPrefix', event.target.value)} placeholder="https://cdn.example.com/imgbed/file/" /></Field>
        <Field label={t('imgbed.settings.default_folder' as never)}><Input value={value.defaultFolder} onChange={(event) => set('defaultFolder', event.target.value)} placeholder={t('imgbed.settings.folder_placeholder' as never)} /></Field>
        <Field label={t('imgbed.settings.default_name_type' as never)}>
          <Select value={value.defaultNameType} onChange={(event) => set('defaultNameType', event.target.value as ImgbedPageSettings['defaultNameType'])}>
            <option value="default">{t('imgbed.name.default' as never)}</option>
            <option value="index">{t('imgbed.name.index' as never)}</option>
            <option value="origin">{t('imgbed.name.origin' as never)}</option>
            <option value="short">{t('imgbed.name.short' as never)}</option>
          </Select>
        </Field>
        <Field label={t('imgbed.settings.default_upload_channel' as never)}>
          <Select value={value.defaultUploadChannel} onChange={(event) => set('defaultUploadChannel', event.target.value as ImgbedPageSettings['defaultUploadChannel'])}>
            {['telegram', 'cfr2', 's3', 'discord', 'huggingface', 'webdav'].map((type) => <option key={type} value={type}>{type}</option>)}
          </Select>
        </Field>
        <Field label={t('imgbed.settings.default_channel_name' as never)}><Input value={value.defaultChannelName} onChange={(event) => set('defaultChannelName', event.target.value)} /></Field>
        <Field label={t('imgbed.settings.default_compress' as never)}><div className="flex flex-wrap gap-3"><Checkbox checked={value.defaultCompress} onChange={(next) => set('defaultCompress', next)} label={t('imgbed.upload.compress')} /><Checkbox checked={value.defaultConvertToWebp} onChange={(next) => set('defaultConvertToWebp', next)} label={t('imgbed.settings.default_webp' as never)} /><Checkbox checked={value.showDirectorySuggestions} onChange={(next) => set('showDirectorySuggestions', next)} label={t('imgbed.settings.show_directory' as never)} /></div></Field>
        <Field label={t('imgbed.settings.compress_threshold' as never)}><Input type="number" value={value.defaultCompressBar} onChange={(event) => set('defaultCompressBar', Number(event.target.value))} /></Field>
        <Field label={t('imgbed.settings.compress_quality' as never)}><Input type="number" value={value.defaultCompressQuality} onChange={(event) => set('defaultCompressQuality', Number(event.target.value))} /></Field>
      </div>
      <div className="mt-3"><SaveRow saving={saving} save={save} /></div>
    </Panel>
  )
}

export function UploadSettingsForm(): ReactElement {
  const { value, setValue, loaded, saving, save } = useGroup<ImgbedUploadSettings>('upload')
  if (!loaded || !value) return <LoadingBlock label={t('imgbed.common.loading')} />
  return (
    <Panel>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('imgbed.settings.max_file_size' as never)}><Input type="number" value={value.maxFileSizeMB} onChange={(event) => setValue({ ...value, maxFileSizeMB: Number(event.target.value) })} /></Field>
        <Field label={t('imgbed.settings.chunk_threshold' as never)}><Input type="number" value={value.chunkThresholdMB} onChange={(event) => setValue({ ...value, chunkThresholdMB: Number(event.target.value) })} /></Field>
        <Field label={t('imgbed.settings.load_balance' as never)} className="md:col-span-2">
          <div className="flex flex-wrap gap-3">
            {(['telegram', 'cfr2', 's3', 'discord', 'huggingface', 'webdav'] as const).map((type) => (
              <Checkbox key={type} checked={value.loadBalance[type]} onChange={(next) => setValue({ ...value, loadBalance: { ...value.loadBalance, [type]: next } })} label={type} />
            ))}
          </div>
        </Field>
      </div>
      <div className="mt-3"><SaveRow saving={saving} save={save} /></div>
    </Panel>
  )
}

export function OthersSettingsForm(): ReactElement {
  const { value, setValue, loaded, saving, save } = useGroup<ImgbedOthersSettings>('others')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  if (!loaded || !value) return <LoadingBlock label={t('imgbed.common.loading')} />
  const hasPassword = Boolean((value.webDAV as unknown as { hasPassword?: boolean }).hasPassword)
  return (
    <Panel>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('imgbed.settings.public_browse' as never)}><div className="flex flex-col gap-2"><Switch checked={value.publicBrowse.enabled} onChange={(next) => setValue({ ...value, publicBrowse: { ...value.publicBrowse, enabled: next } })} label={t('imgbed.settings.enabled')} /><Input value={value.publicBrowse.allowedDir} onChange={(event) => setValue({ ...value, publicBrowse: { ...value.publicBrowse, allowedDir: event.target.value } })} placeholder={t('imgbed.settings.allowed_dir' as never)} /></div></Field>
        <Field label={t('imgbed.settings.random_api' as never)}><div className="flex flex-col gap-2"><Switch checked={value.randomImageAPI.enabled} onChange={(next) => setValue({ ...value, randomImageAPI: { ...value.randomImageAPI, enabled: next } })} label={t('imgbed.settings.enabled')} /><Input value={value.randomImageAPI.allowedDir} onChange={(event) => setValue({ ...value, randomImageAPI: { ...value.randomImageAPI, allowedDir: event.target.value } })} placeholder={t('imgbed.settings.allowed_dir' as never)} /></div></Field>
        <Field label={t('imgbed.settings.webdav_enabled' as never)} className="md:col-span-2"><Switch checked={value.webDAV.enabled} onChange={(next) => setValue({ ...value, webDAV: { ...value.webDAV, enabled: next } })} label={t('imgbed.settings.enabled')} /></Field>
        <Field label={t('imgbed.settings.webdav_user' as never)}><Input value={value.webDAV.username} onChange={(event) => setValue({ ...value, webDAV: { ...value.webDAV, username: event.target.value } })} /></Field>
        <Field label={t('imgbed.settings.webdav_password' as never)}><Input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setClearPassword(false) }} placeholder={hasPassword ? '••••••••' : ''} trailing={hasPassword ? <button type="button" className="text-[length:var(--text-10-5)] text-[var(--danger)]" onClick={() => { setPassword(''); setClearPassword(true) }}>{t('imgbed.settings.clear' as never)}</button> : undefined} /></Field>
        <Field label={t('imgbed.settings.webdav_channel' as never)}><Input value={value.webDAV.uploadChannel} onChange={(event) => setValue({ ...value, webDAV: { ...value.webDAV, uploadChannel: event.target.value } })} placeholder="cfr2" /></Field>
        <Field label={t('imgbed.settings.webdav_channel_name' as never)}><Input value={value.webDAV.channelName} onChange={(event) => setValue({ ...value, webDAV: { ...value.webDAV, channelName: event.target.value } })} /></Field>
      </div>
      <div className="mt-3 flex justify-end"><Button loading={saving} onClick={() => void save({ ...value, webDAV: { ...value.webDAV, ...(password ? { password } : {}), ...(clearPassword ? { clearPassword: true } : {}) } }).then(() => { setPassword(''); setClearPassword(false) })}>{t('imgbed.settings.save')}</Button></div>
    </Panel>
  )
}

export function SecuritySettingsForm(): ReactElement {
  const { value, setValue, loaded, saving, save, extra } = useGroup<ImgbedSecuritySettings>('security')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  if (!loaded || !value) return <LoadingBlock label={t('imgbed.common.loading')} />
  const hasKey = Boolean(extra.hasModerateKey)
  return (
    <Panel>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('imgbed.settings.white_list_mode' as never)}><Switch checked={value.access.whiteListMode} onChange={(next) => setValue({ ...value, access: { ...value.access, whiteListMode: next } })} label={t('imgbed.settings.enabled')} /></Field>
        <Field label={t('imgbed.settings.allowed_domains' as never)}><Input value={value.access.allowedDomains} onChange={(event) => setValue({ ...value, access: { ...value.access, allowedDomains: event.target.value } })} placeholder={t('imgbed.settings.domains_placeholder' as never)} /></Field>
        <Field label={t('imgbed.settings.image_transform' as never)}><Switch checked={value.access.imageTransformEnabled} onChange={(next) => setValue({ ...value, access: { ...value.access, imageTransformEnabled: next } })} label={t('imgbed.settings.enabled')} /></Field>
        <Field label={t('imgbed.settings.allowed_sizes' as never)}><Input value={value.access.imageTransformAllowedSizes} onChange={(event) => setValue({ ...value, access: { ...value.access, imageTransformAllowedSizes: event.target.value } })} placeholder={t('imgbed.settings.sizes_placeholder' as never)} /></Field>
        <Field label={t('imgbed.settings.moderation' as never)} className="md:col-span-2"><Switch checked={value.moderate.enabled} onChange={(next) => setValue({ ...value, moderate: { ...value.moderate, enabled: next } })} label={t('imgbed.settings.enabled')} /></Field>
        <Field label={t('imgbed.settings.moderation_channel' as never)}><Select value={value.moderate.channel} onChange={(event) => setValue({ ...value, moderate: { ...value.moderate, channel: event.target.value as ImgbedSecuritySettings['moderate']['channel'] } })}><option value="moderatecontent.com">{t('imgbed.moderation.moderatecontent')}</option><option value="nsfwjs">{t('imgbed.moderation.nsfwjs')}</option></Select></Field>
        <Field label={t('imgbed.settings.moderation_key' as never)}><Input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false) }} placeholder={hasKey ? '••••••••' : ''} trailing={hasKey ? <button type="button" className="text-[length:var(--text-10-5)] text-[var(--danger)]" onClick={() => { setApiKey(''); setClearKey(true) }}>{t('imgbed.settings.clear' as never)}</button> : undefined} /></Field>
        <Field label={t('imgbed.settings.nsfw_path' as never)}><Input value={value.moderate.nsfwApiPath} onChange={(event) => setValue({ ...value, moderate: { ...value.moderate, nsfwApiPath: event.target.value } })} placeholder="https://nsfw.example.com/api" /></Field>
        <Field label={t('imgbed.settings.ip_query' as never)}><Switch checked={value.ipQuery.enabled} onChange={(next) => setValue({ ...value, ipQuery: { ...value.ipQuery, enabled: next } })} label={t('imgbed.settings.enabled')} /></Field>
        <Field label={t('imgbed.settings.ip_query_url' as never)}><Input value={value.ipQuery.customApi.url} onChange={(event) => setValue({ ...value, ipQuery: { ...value.ipQuery, customApi: { ...value.ipQuery.customApi, url: event.target.value } } })} placeholder="https://ip.example.com/?ip={ip}" /></Field>
        <Field label={t('imgbed.settings.ip_query_fields' as never)}><Input value={value.ipQuery.customApi.responseFields.join(', ')} onChange={(event) => setValue({ ...value, ipQuery: { ...value.ipQuery, customApi: { ...value.ipQuery.customApi, responseFields: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } } })} placeholder={t('imgbed.settings.fields_placeholder' as never)} /></Field>
      </div>
      <div className="mt-3"><SaveRow saving={saving} save={() => save({ ...value, moderate: { ...value.moderate, moderateContentApiKey: apiKey, ...(clearKey ? { clearApiKey: true } : {}) } }).then(() => { setApiKey(''); setClearKey(false) })} /></div>
    </Panel>
  )
}

interface AiModelOption { id: string; label: string; providerLabel: string }

export function AiSettingsForm(): ReactElement {
  const { value, setValue, loaded, saving, save } = useGroup<ImgbedAiSettings>('ai')
  const [models, setModels] = useState<AiModelOption[]>([])
  const [preferred, setPreferred] = useState('')
  useEffect(() => {
    imgbedApi<{ models: AiModelOption[] }>('/api/imgbed/ai/tags').then((result) => setModels(result.models)).catch(() => setModels([]))
  }, [])
  useEffect(() => { if (value) setPreferred(value.preferredTags.join(', ')) }, [loaded])
  if (!loaded || !value) return <LoadingBlock label={t('imgbed.common.loading')} />
  return (
    <Panel>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('imgbed.settings.ai_enabled' as never)}><Switch checked={value.enabled} onChange={(next) => setValue({ ...value, enabled: next })} label={t('imgbed.settings.enabled')} /></Field>
        <Field label={t('imgbed.settings.ai_model' as never)}><Select value={value.modelId} onChange={(event) => setValue({ ...value, modelId: event.target.value })}><option value="">—</option>{models.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.providerLabel}</option>)}</Select>{!models.length && <p className="mt-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('imgbed.settings.no_models' as never)}</p>}</Field>
        <Field label={t('imgbed.settings.ai_language' as never)}><Select value={value.language} onChange={(event) => setValue({ ...value, language: event.target.value as ImgbedAiSettings['language'] })}><option value="zh-CN">{t('imgbed.language.zh')}</option><option value="en">{t('imgbed.language.en')}</option></Select></Field>
        <Field label={t('imgbed.settings.ai_max_tags' as never)}><Input type="number" value={value.maxTags} onChange={(event) => setValue({ ...value, maxTags: Number(event.target.value) })} /></Field>
        <Field label={t('imgbed.settings.ai_prompt' as never)} className="md:col-span-2"><Textarea value={value.prompt} onChange={(event) => setValue({ ...value, prompt: event.target.value })} rows={5} /></Field>
        <Field label={t('imgbed.settings.preferred_tags' as never)} className="md:col-span-2"><Input value={preferred} onChange={(event) => setPreferred(event.target.value)} placeholder={t('imgbed.settings.tags_placeholder' as never)} /></Field>
      </div>
      <div className="mt-3"><SaveRow saving={saving} save={() => save({ ...value, preferredTags: preferred.split(',').map((item) => item.trim()).filter(Boolean) })} /></div>
    </Panel>
  )
}
