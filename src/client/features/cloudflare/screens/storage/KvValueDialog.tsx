/**
 * The KV value editor. A new key can be named; an existing key is fixed, because renaming one is a
 * delete plus a write and the dialog says so by keeping the field read-only.
 */
import { useEffect, useState } from 'react'
import { Button } from '../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { storageApi } from '../../api/storage'
import { useCfT } from '../../i18n'

export function KvValueDialog({
  open,
  accountId,
  namespaceId,
  editKey,
  initialValue,
  readOnly = false,
  onClose,
  onSaved,
}: {
  open: boolean
  accountId: string
  namespaceId: string
  editKey: string | null
  initialValue: string
  readOnly?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [ttl, setTtl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setKey(editKey ?? '')
    setValue(initialValue)
    setTtl('')
    setError('')
    setSaving(false)
  }, [open, editKey, initialValue])

  const ttlNumber = ttl.trim() === '' ? undefined : Number(ttl)
  const ttlValid = ttlNumber === undefined || (Number.isInteger(ttlNumber) && ttlNumber >= 60)
  const canSave = key.trim().length > 0 && ttlValid && !saving && !readOnly

  async function save(): Promise<void> {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      await storageApi.putKvValue(accountId, namespaceId, key.trim(), value, {
        ...(ttlNumber !== undefined ? { expiration_ttl: ttlNumber } : {}),
      })
      toast({ title: t('cloudflare.storage.msg.kv_saved'), tone: 'success' })
      onSaved()
      onClose()
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editKey ? t('cloudflare.storage.kv_editor_edit_title') : t('cloudflare.storage.kv_editor_title')}
      width={560}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{uiT('common.cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => { void save() }}>
            {uiT('common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('cloudflare.storage.key_placeholder')}>
          <Input
            value={key}
            disabled={Boolean(editKey)}
            placeholder={t('cloudflare.storage.key_placeholder')}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        <Field label={t('cloudflare.storage.value_placeholder')}>
          <Textarea
            value={value}
            rows={8}
            placeholder={t('cloudflare.storage.value_placeholder')}
            className="max-h-72 overflow-y-auto font-mono text-[length:var(--text-12-5)]"
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <Field label={t('cloudflare.storage.ttl_seconds')} hint={t('cloudflare.storage.ttl_placeholder')}>
          <Input
            type="number"
            min={60}
            value={ttl}
            invalid={!ttlValid}
            placeholder={t('cloudflare.storage.ttl_placeholder')}
            onChange={(event) => setTtl(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
