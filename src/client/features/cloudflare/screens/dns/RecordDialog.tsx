/**
 * One record, created or edited.
 *
 * The fields follow the record type: proxying exists only for the three types Cloudflare proxies,
 * priority only for MX, and SRV adds weight and port. A type change therefore also clears the fields
 * the new type cannot carry, rather than sending them and letting the API refuse.
 */
import { useState } from 'react'
import { Field, Input, Switch } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsApi, type DnsRecord, type DnsRecordType, type RecordInput } from '../../api/dns'
import { useCfT } from '../../i18n'
import { isProxiable, RECORD_TYPE_CHOICES } from './options'

export function RecordDialog({
  domain,
  record,
  onClose,
  onSaved,
}: {
  domain: string
  record: DnsRecord | null
  onClose: () => void
  onSaved: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const editing = record !== null
  const [type, setType] = useState<DnsRecordType>((record?.type as DnsRecordType | undefined) ?? 'A')
  const [name, setName] = useState(record?.name ?? '')
  const [content, setContent] = useState(record?.content ?? '')
  const [ttl, setTtl] = useState(record?.ttl ?? 300)
  const [proxied, setProxied] = useState(record?.proxied ?? false)
  const [priority, setPriority] = useState(record?.priority ?? 10)
  const weight = record?.weight ?? 0
  const port = record?.port ?? 0
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function changeType(next: DnsRecordType): void {
    setType(next)
    if (!isProxiable(next)) setProxied(false)
  }

  async function submit(): Promise<void> {
    if (!name.trim()) {
      setError(t('cloudflare.dns.record_name_required'))
      return
    }
    if (!content.trim()) {
      setError(t('cloudflare.dns.record_content_required'))
      return
    }
    const input: RecordInput = {
      type,
      name: name.trim(),
      content: content.trim(),
      ttl,
      proxied: isProxiable(type) ? proxied : false,
    }
    if (type === 'MX') input.priority = priority
    if (type === 'SRV') {
      input.priority = priority
      input.weight = weight
      input.port = port
    }
    setBusy(true)
    setError('')
    try {
      if (record) {
        await dnsApi.updateRecord(domain, record.id, input)
        toast({ title: t('cloudflare.settings.msg.source_saved'), tone: 'success' })
      } else {
        await dnsApi.createRecord(domain, input)
        toast({ title: t('cloudflare.dns.msg.record_added'), tone: 'success' })
      }
      onSaved()
    } catch (reason) {
      const message = cfErrorText(reason)
      setError(message)
      toast({
        title: editing ? t('cloudflare.dns.msg.update_failed') : t('cloudflare.dns.msg.add_failed'),
        description: message,
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? uiT('common.edit') : t('cloudflare.dns.add_record_modal_title')}
      width={540}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{uiT('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {editing ? uiT('common.save') : t('cloudflare.dns.add_record')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('cloudflare.dns.record_type')} required>
          <div>
            <SelectMenu
              label={t('cloudflare.dns.record_type')}
              value={type}
              options={RECORD_TYPE_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
              onChange={changeType}
            />
          </div>
        </Field>
        <Field label={t('cloudflare.dns.record_name')} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('cloudflare.dns.record_name_placeholder')}
          />
        </Field>
        {type === 'MX' && (
          <Field label={t('cloudflare.dns.priority')}>
            <Input
              type="number"
              min={0}
              max={65535}
              className="w-32"
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value) || 0)}
            />
          </Field>
        )}
        {type === 'SRV' && (
          <Field label={t('cloudflare.dns.priority')}>
            <Input
              type="number"
              min={0}
              max={65535}
              className="w-32"
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value) || 0)}
            />
          </Field>
        )}
        <Field label={t('cloudflare.dns.record_content')} required>
          <Input
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t('cloudflare.dns.record_content_placeholder')}
          />
        </Field>
        <Field label={t('cloudflare.dns.ttl')}>
          <Input
            type="number"
            min={1}
            max={86400}
            className="w-32"
            value={ttl}
            onChange={(event) => setTtl(Number(event.target.value) || 1)}
          />
        </Field>
        {isProxiable(type) && (
          <div className="flex items-center gap-2">
            <Switch checked={proxied} onChange={setProxied} label={t('cloudflare.dns.proxied')} />
            <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
              {t('cloudflare.dns.proxied')}
            </span>
          </div>
        )}
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
