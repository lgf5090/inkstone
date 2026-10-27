/**
 * Preview an object without leaving the browser: images as an `<img>`, text as a read-only block.
 *
 * The bytes come from the same download route a reader could use, so a preview never grants access to
 * anything the download does not. The object URL is revoked when the dialog closes or the object changes.
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '../../../../components/primitives'
import { Modal } from '../../../../components/overlay'
import { t as uiT } from '../../../../lib/i18n'
import { downloadBlob } from '../../../../lib/export-note'
import { cfErrorText } from '../../api/client'
import { storageApi, type R2ObjectInfo } from '../../api/storage'
import { useCfT } from '../../i18n'
import { previewKindFor } from './r2-preview'

const TEXT_PREVIEW_LIMIT = 200_000

function displayName(key: string): string {
  return key.split('/').pop() || key
}

export function R2PreviewDialog({
  open,
  accountId,
  bucket,
  object,
  onClose,
}: {
  open: boolean
  accountId: string
  bucket: string
  object: R2ObjectInfo | null
  onClose: () => void
}) {
  const t = useCfT()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [text, setText] = useState('')

  const kind = object ? previewKindFor(object.content_type, object.key) : null

  useEffect(() => {
    setImageUrl('')
    setText('')
    setError('')
    if (!open || !object) return
    let cancelled = false
    setLoading(true)
    void storageApi.downloadR2Object(accountId, bucket, object.key)
      .then(async (download) => {
        if (cancelled) return
        if (kind === 'image') {
          setImageUrl(URL.createObjectURL(download.blob))
          return
        }
        if (kind === 'text') {
          const content = await download.blob.text()
          if (!cancelled) setText(content.slice(0, TEXT_PREVIEW_LIMIT))
          return
        }
        setError(t('cloudflare.storage.msg.image_load_failed'))
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(cfErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, object, accountId, bucket, kind, t])

  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl)
  }, [imageUrl])

  async function downloadOriginal(): Promise<void> {
    if (!object) return
    try {
      const download = await storageApi.downloadR2Object(accountId, bucket, object.key)
      downloadBlob(download.filename, download.blob)
    } catch (reason) {
      setError(cfErrorText(reason))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={object ? t('cloudflare.storage.r2_preview_title', { name: displayName(object.key) }) : ''}
      width={920}
      footer={(
        <>
          <Button variant="secondary" disabled={!object} onClick={() => { void downloadOriginal() }}>
            {t('cloudflare.storage.download_original')}
          </Button>
          <Button variant="primary" onClick={onClose}>{uiT('common.close')}</Button>
        </>
      )}
    >
      <div className="flex min-h-32 items-center justify-center">
        {loading ? (
          <p className="flex items-center gap-2 py-8 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <Loader2 size={15} className="animate-spin" />
            {uiT('common.loading')}
          </p>
        ) : error ? (
          <p role="alert" className="py-8 text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>
        ) : imageUrl ? (
          <img
            src={imageUrl}
            alt={object ? displayName(object.key) : ''}
            className="max-h-[70vh] max-w-full rounded-[var(--r-md)] object-contain"
            onError={() => setError(t('cloudflare.storage.msg.image_load_failed'))}
          />
        ) : kind === 'text' ? (
          <pre className="max-h-[70vh] w-full overflow-auto whitespace-pre-wrap rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">
            {text}
          </pre>
        ) : null}
      </div>
    </Modal>
  )
}
