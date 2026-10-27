/**
 * Upload one file under the current folder. The key is the folder plus the file's own name; a reader
 * who wants a different name drops the file into a folder with that shape or renames it before upload.
 */
import { useEffect, useState } from 'react'
import { Button } from '../../../../components/primitives'
import { Field, Input } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'
import { storageApi } from '../../api/storage'
import { useCfT } from '../../i18n'

function folderOf(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '')
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

export function R2UploadDialog({
  open,
  accountId,
  bucket,
  prefix,
  onClose,
  onUploaded,
}: {
  open: boolean
  accountId: string
  bucket: string
  prefix: string
  onClose: () => void
  onUploaded: () => void
}) {
  const t = useCfT()
  const [prefixDraft, setPrefixDraft] = useState(prefix)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setPrefixDraft(prefix)
    setFile(null)
    setError('')
    setUploading(false)
  }, [open, prefix])

  async function upload(): Promise<void> {
    if (!file || uploading) return
    const folder = folderOf(prefixDraft)
    const key = `${folder}${file.name}`
    if (key.startsWith('/') || key.includes('..')) {
      setError(uiT('common.action_failed'))
      return
    }
    setUploading(true)
    setError('')
    try {
      await storageApi.uploadR2Object(accountId, bucket, key, file)
      onUploaded()
      onClose()
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudflare.storage.upload_file_title')}
      width={480}
      dismissible={!uploading}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={uploading}>{uiT('common.cancel')}</Button>
          <Button variant="primary" loading={uploading} disabled={!file} onClick={() => { void upload() }}>
            {t('cloudflare.storage.upload')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('cloudflare.storage.path_prefix')}>
          <Input
            value={prefixDraft}
            placeholder={prefix || '/'}
            onChange={(event) => setPrefixDraft(event.target.value)}
          />
        </Field>
        <Field label={t('cloudflare.storage.select_file')} hint={file?.name}>
          <Input
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>
        )}
      </div>
    </Modal>
  )
}
