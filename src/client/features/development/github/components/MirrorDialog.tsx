import { useState } from 'react'
import { Check, Globe, Plus, Trash2 } from 'lucide-react'
import type { GithubMirrorSource } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { Button, IconButton } from '../../../../components/primitives'
import { Input, Switch } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { cn } from '../../../../lib/cn'
import { useUi } from '../../../../store/ui'

function validMirrorUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

export function MirrorDialog({
  open,
  onClose,
  mirrors,
  currentMirrorId,
  onSave,
  onCurrentChange,
}: {
  open: boolean
  onClose: () => void
  mirrors: GithubMirrorSource[]
  currentMirrorId: string
  onSave: (mirrors: GithubMirrorSource[]) => void
  onCurrentChange: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const toast = useUi((state) => state.toast)

  const add = () => {
    const trimmedName = name.trim()
    const trimmedUrl = url.trim().replace(/\/$/, '')
    if (!trimmedName || !trimmedUrl) return
    if (!validMirrorUrl(trimmedUrl)) {
      setError(t('development.github.mirrors.invalid_url'))
      return
    }
    onSave([...mirrors, {
      id: `gh-mirror-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: trimmedName,
      url: trimmedUrl,
      enabled: true,
      createdAt: Date.now(),
    }])
    setName('')
    setUrl('')
    setError(null)
    toast({ title: t('development.github.mirrors.saved'), tone: 'success' })
  }

  const remove = (id: string) => {
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
          <p className="text-[length:var(--text-12)] font-medium">{t('development.github.mirrors.existing')}</p>
          {mirrors.length === 0 ? (
            <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-3 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.github.mirrors.empty')}
            </p>
          ) : mirrors.map((mirror) => {
            const current = mirror.id === currentMirrorId
            return (
              <div key={mirror.id} className={cn('flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2', current && 'border-[var(--accent)] bg-[var(--accent-soft)]')}>
                <Globe size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[length:var(--text-12)] font-medium">{mirror.name}</div>
                  <div className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{mirror.url}</div>
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
                <IconButton label={t('common.delete')} size="sm" onClick={() => remove(mirror.id)}><Trash2 size={13} /></IconButton>
              </div>
            )
          })}
        </div>

        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('development.github.mirrors.format_hint')}{' '}
          <code className="rounded bg-[var(--bg-inset)] px-1">{t('development.github.mirrors.format_example')}</code>
        </p>
      </div>
    </Modal>
  )
}
