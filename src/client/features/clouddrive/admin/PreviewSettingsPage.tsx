import { useEffect, useState } from 'react'
import { DEFAULT_PREVIEW_EXTENSIONS, DEFAULT_PREVIEW_RULES, type CloudDrivePreviewRule } from '@shared/clouddrive/settings'
import { Button } from '../../../components/primitives'
import { Field, Textarea } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { clouddriveApi } from '../api'
import { AdminCard, AdminError, AdminForbidden, AdminLoading, AdminPage, adminT, useAdminOwner } from './shared'

export function PreviewSettingsPage() {
  const owner = useAdminOwner()
  const toast = useUi((state) => state.toast)
  const [text, setText] = useState('')
  const [image, setImage] = useState('')
  const [video, setVideo] = useState('')
  const [audio, setAudio] = useState('')
  const [rules, setRules] = useState('[]')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const apply = (settings: Awaited<ReturnType<typeof clouddriveApi.settings>>['settings']) => {
    setText(settings.previewTextExtensions.join(', '))
    setImage(settings.previewImageExtensions.join(', '))
    setVideo(settings.previewVideoExtensions.join(', '))
    setAudio(settings.previewAudioExtensions.join(', '))
    setRules(JSON.stringify(settings.previewRules, null, 2))
  }
  const load = async () => {
    setStatus('loading'); setError(null)
    try { apply((await clouddriveApi.settings()).settings); setStatus('ready') } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setStatus('error') }
  }
  useEffect(() => { if (owner) void load() }, [owner])
  if (!owner) return <AdminForbidden />

  const save = async () => {
    let parsed: CloudDrivePreviewRule[]
    try { parsed = JSON.parse(rules) as CloudDrivePreviewRule[] } catch { toast({ title: adminT('clouddrive.admin.preview.json_invalid'), tone: 'danger' }); return }
    const list = (value: string) => value.split(',').map((item) => item.trim().toLocaleLowerCase().replace(/^\./, '')).filter(Boolean)
    setSaving(true)
    try {
      const result = await clouddriveApi.patchSettings({ previewTextExtensions: list(text), previewImageExtensions: list(image), previewVideoExtensions: list(video), previewAudioExtensions: list(audio), previewRules: parsed })
      apply(result.settings)
      toast({ title: adminT('clouddrive.admin.preview.saved') })
    } catch (caught) { toast({ title: adminT('clouddrive.common.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' }) } finally { setSaving(false) }
  }

  const reset = () => {
    setText(DEFAULT_PREVIEW_EXTENSIONS.text.join(', ')); setImage(DEFAULT_PREVIEW_EXTENSIONS.image.join(', ')); setVideo(DEFAULT_PREVIEW_EXTENSIONS.video.join(', ')); setAudio(DEFAULT_PREVIEW_EXTENSIONS.audio.join(', ')); setRules(JSON.stringify(DEFAULT_PREVIEW_RULES, null, 2)); toast({ title: adminT('clouddrive.admin.preview.reset_done') })
  }

  return (
    <AdminPage title={adminT('clouddrive.admin.preview.title')} description={adminT('clouddrive.admin.preview.description')} actions={<><Button size="sm" variant="ghost" onClick={reset}>{adminT('clouddrive.admin.preview.reset')}</Button><Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>{adminT('clouddrive.admin.preview.save')}</Button></>}>
      {status === 'loading' && <AdminLoading />}
      {status === 'error' && <AdminError message={error} onRetry={() => void load()} />}
      {status === 'ready' && (
        <div className="flex flex-col gap-3">
          <AdminCard hint={adminT('clouddrive.admin.preview.extensions_hint')}>
            <div className="grid gap-2">
              <Field label={adminT('clouddrive.admin.preview.text_extensions')}><Textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} /></Field>
              <Field label={adminT('clouddrive.admin.preview.image_extensions')}><Textarea rows={2} value={image} onChange={(event) => setImage(event.target.value)} /></Field>
              <Field label={adminT('clouddrive.admin.preview.video_extensions')}><Textarea rows={2} value={video} onChange={(event) => setVideo(event.target.value)} /></Field>
              <Field label={adminT('clouddrive.admin.preview.audio_extensions')}><Textarea rows={2} value={audio} onChange={(event) => setAudio(event.target.value)} /></Field>
            </div>
          </AdminCard>
          <AdminCard title={adminT('clouddrive.admin.preview.rules')} hint={adminT('clouddrive.admin.preview.rules_hint')}>
            <Textarea rows={12} value={rules} onChange={(event) => setRules(event.target.value)} className="font-mono" aria-label={adminT('clouddrive.admin.preview.rules')} />
          </AdminCard>
        </div>
      )}
    </AdminPage>
  )
}
