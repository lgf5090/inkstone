import { useEffect, useState } from 'react'
import { Check, Gauge, Globe, Plus, Trash2 } from 'lucide-react'
import type { GithubMirrorProbeResult, GithubMirrorSource } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Input, Switch } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { cn } from '../../../../lib/cn'
import { useUi } from '../../../../store/ui'
import { normalizeMirrorUrl } from '../lib/mirror'

export function MirrorDialog({
  open,
  onClose,
  mirrors,
  currentMirrorId,
  onSave,
  onCurrentChange,
  onProbe,
}: {
  open: boolean
  onClose: () => void
  mirrors: GithubMirrorSource[]
  currentMirrorId: string
  onSave: (mirrors: GithubMirrorSource[]) => void
  onCurrentChange: (id: string) => void
  onProbe: (mirrors: readonly GithubMirrorSource[]) => Promise<GithubMirrorProbeResult[]>
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [probes, setProbes] = useState<Map<string, GithubMirrorProbeResult>>(new Map())
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    setProbes(new Map())
  }, [mirrors])

  const runProbe = async () => {
    if (probing || mirrors.length === 0) return
    setProbing(true)
    try {
      const results = await onProbe(mirrors)
      setProbes(new Map(results.map((result) => [result.id, result])))
    } catch (cause) {
      toast({
        title: t('development.github.mirrors.probe_failed'),
        description: cause instanceof Error ? cause.message : undefined,
        tone: 'danger',
      })
    } finally {
      setProbing(false)
    }
  }

  const probeLabel = (result: GithubMirrorProbeResult): string => {
    if (result.ok) return t('development.github.mirrors.probe_ok', { ms: result.latencyMs ?? 0 })
    if (result.error === 'timeout') return t('development.github.mirrors.probe_timeout')
    if (result.error === 'blocked') return t('development.github.mirrors.probe_blocked')
    if (result.error === 'http') return t('development.github.mirrors.probe_http', { status: result.status })
    return t('development.github.mirrors.probe_network')
  }

  const add = () => {
    const trimmedName = name.trim()
    if (!trimmedName) return
    const normalizedUrl = normalizeMirrorUrl(url)
    if (!normalizedUrl) {
      setError(t('development.github.mirrors.invalid_url'))
      return
    }
    onSave([...mirrors, {
      id: `gh-mirror-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: trimmedName,
      url: normalizedUrl,
      enabled: true,
      createdAt: Date.now(),
    }])
    setName('')
    setUrl('')
    setError(null)
    toast({ title: t('development.github.mirrors.saved'), tone: 'success' })
  }

  const remove = (id: string) => {
    if (mirrors.length <= 1) return
    const next = mirrors.filter((mirror) => mirror.id !== id)
    onSave(next)
    if (currentMirrorId === id) {
      const fallback = next.find((mirror) => mirror.enabled) ?? next[0]
      if (fallback) onCurrentChange(fallback.id)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.github.mirrors.manage')}
      description={t('development.github.mirrors.desc')}
      width={560}
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3">
        <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <p className="text-[length:var(--text-12)] font-medium">{t('development.github.mirrors.add_new')}</p>
          <Input value={name} onChange={(event) => { setName(event.target.value); setError(null) }} placeholder={t('development.github.mirrors.name_placeholder')} className="h-8" />
          <Input value={url} onChange={(event) => { setUrl(event.target.value); setError(null) }} placeholder={t('development.github.mirrors.url_placeholder')} className="h-8" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') add() }} />
          {error && <p className="text-[length:var(--text-11)] text-[var(--danger)]" role="alert">{error}</p>}
          <Button size="sm" onClick={add} disabled={!name.trim() || !url.trim()}>
            <Plus size={13} /> {t('development.github.mirrors.add')}
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[length:var(--text-12)] font-medium">{t('development.github.mirrors.existing')}</p>
            <Button variant="secondary" size="sm" onClick={() => void runProbe()} disabled={probing || mirrors.length === 0}>
              {probing ? <Spinner size={12} /> : <Gauge size={12} />} {t('development.github.mirrors.probe')}
            </Button>
          </div>
          {mirrors.length === 0 ? (
            <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-3 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.github.mirrors.empty')}
            </p>
          ) : mirrors.map((mirror) => {
            const current = mirror.id === currentMirrorId
            const probe = probes.get(mirror.id)
            return (
              <div key={mirror.id} className={cn('flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2', current && 'border-[var(--accent)] bg-[var(--accent-soft)]')}>
                <Globe size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[length:var(--text-12)] font-medium">{mirror.name}</div>
                  <div className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{mirror.url}</div>
                  <div role="status" className="text-[length:var(--text-11)] tabular-nums">
                    {probing ? (
                      <span className="text-[var(--text-quaternary)]">{t('development.github.mirrors.probing')}</span>
                    ) : probe ? (
                      <span className={probe.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>{probeLabel(probe)}</span>
                    ) : null}
                  </div>
                </div>
                <Switch checked={mirror.enabled} onChange={(enabled) => onSave(mirrors.map((entry) => entry.id === mirror.id ? { ...entry, enabled } : entry))} label={t('development.github.mirrors.toggle_enabled')} />
                <Button
                  variant={current ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={!mirror.enabled}
                  onClick={() => onCurrentChange(mirror.id)}
                >
                  {current ? <><Check size={12} /> {t('development.github.mirrors.current_label')}</> : t('development.github.mirrors.set_current')}
                </Button>
                <IconButton
                  label={mirrors.length > 1 ? t('common.delete') : t('development.github.mirrors.keep_one')}
                  size="sm"
                  disabled={mirrors.length <= 1}
                  onClick={() => remove(mirror.id)}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            )
          })}
        </div>

        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('development.github.mirrors.format_hint')}{' '}
          <code className="rounded bg-[var(--bg-inset)] px-1">{t('development.github.mirrors.format_example')}</code>
        </p>
        {mirrors.length <= 1 && <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.mirrors.keep_one')}</p>}
      </div>
    </Modal>
  )
}
