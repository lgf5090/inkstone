import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  CLOUDDRIVE_PREVIEW_TYPES,
  DEFAULT_PREVIEW_RULES,
  type CloudDrivePreviewRule,
  type CloudDrivePreviewType,
} from '@shared/clouddrive/settings'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Select } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { clouddriveApi } from '../api'
import {
  AdminCard,
  AdminError,
  AdminForbidden,
  AdminLoading,
  AdminNotice,
  AdminPage,
  adminT,
  useAdminOwner,
  type CloudDriveAdminMessageKey,
} from './shared'

interface DraftRule {
  id: string
  type: CloudDrivePreviewType
  priority: number
  extensions: string
}

const TYPE_LABEL_KEYS: Record<CloudDrivePreviewType, CloudDriveAdminMessageKey> = {
  text: 'clouddrive.admin.preview.type.text',
  image: 'clouddrive.admin.preview.type.image',
  video: 'clouddrive.admin.preview.type.video',
  audio: 'clouddrive.admin.preview.type.audio',
  pdf: 'clouddrive.admin.preview.type.pdf',
  office: 'clouddrive.admin.preview.type.office',
  archive: 'clouddrive.admin.preview.type.archive',
  ofd: 'clouddrive.admin.preview.type.ofd',
  native: 'clouddrive.admin.preview.type.native',
  none: 'clouddrive.admin.preview.type.none',
}

const EXTENSION_SPLIT = /[\s,;]+/
const EXTENSION_SHAPE = /^[a-z0-9][a-z0-9+_-]{0,31}$/

function toDraft(rules: readonly CloudDrivePreviewRule[]): DraftRule[] {
  return rules.map((rule) => ({
    id: rule.id,
    type: rule.type,
    priority: rule.priority,
    extensions: rule.extensions.join(', '),
  }))
}

function extensionsOf(text: string): string[] {
  return [...new Set(text.split(EXTENSION_SPLIT).map((item) => item.toLocaleLowerCase().replace(/^\./, '')).filter(Boolean))]
}

function toRule(draft: DraftRule): CloudDrivePreviewRule {
  return { id: draft.id, type: draft.type, priority: draft.priority, extensions: extensionsOf(draft.extensions) }
}

function isPriority(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100
}

/** Extensions more than one rule claims; the viewer stops at the first one. */
function contestedExtensions(rules: readonly CloudDrivePreviewRule[]): string[] {
  const seen = new Set<string>()
  const contested = new Set<string>()
  for (const rule of rules) {
    for (const extension of rule.extensions) {
      if (seen.has(extension)) contested.add(extension)
      seen.add(extension)
    }
  }
  return [...contested].sort()
}

export function PreviewSettingsPage() {
  const owner = useAdminOwner()
  const toast = useUi((state) => state.toast)
  const [drafts, setDrafts] = useState<DraftRule[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const apply = (rules: readonly CloudDrivePreviewRule[]) => setDrafts(toDraft(rules))
  const load = async () => {
    setStatus('loading'); setError(null)
    try { apply((await clouddriveApi.settings()).settings.previewRules); setStatus('ready') } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setStatus('error') }
  }
  useEffect(() => { if (owner) void load() }, [owner])
  if (!owner) return <AdminForbidden />

  const rules = drafts.map(toRule)
  const contested = contestedExtensions(rules)

  const save = async () => {
    const invalid = drafts.findIndex((draft) => !isPriority(draft.priority)
      || extensionsOf(draft.extensions).length === 0
      || extensionsOf(draft.extensions).some((extension) => !EXTENSION_SHAPE.test(extension)))
    if (invalid >= 0) {
      toast({ title: adminT('clouddrive.admin.preview.rule_invalid', { value0: String(invalid + 1) }), tone: 'danger' })
      return
    }
    setSaving(true)
    try {
      const result = await clouddriveApi.patchSettings({ previewRules: rules })
      apply(result.settings.previewRules)
      toast({ title: adminT('clouddrive.admin.preview.saved') })
    } catch (caught) { toast({ title: adminT('clouddrive.common.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' }) } finally { setSaving(false) }
  }

  const reset = () => {
    setDrafts(toDraft(DEFAULT_PREVIEW_RULES))
    toast({ title: adminT('clouddrive.admin.preview.reset_done') })
  }

  const update = (index: number, patch: Partial<DraftRule>) => {
    setDrafts((current) => current.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)))
  }

  const add = () => {
    setDrafts((current) => [...current, { id: `custom-${Date.now().toString(36)}`, type: 'text', priority: 50, extensions: '' }])
  }

  return (
    <AdminPage title={adminT('clouddrive.admin.preview.title')} description={adminT('clouddrive.admin.preview.description')} actions={<><Button size="sm" variant="ghost" onClick={reset}>{adminT('clouddrive.admin.preview.reset')}</Button><Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>{adminT('clouddrive.admin.preview.save')}</Button></>}>
      {status === 'loading' && <AdminLoading />}
      {status === 'error' && <AdminError message={error} onRetry={() => void load()} />}
      {status === 'ready' && (
        <div className="flex flex-col gap-3">
          {contested.length > 0 && (
            <AdminNotice tone="warning">
              {adminT('clouddrive.admin.preview.contested', { value0: contested.slice(0, 8).join(', ') })}
            </AdminNotice>
          )}
          <AdminCard
            title={adminT('clouddrive.admin.preview.rules')}
            hint={adminT('clouddrive.admin.preview.rules_hint')}
            actions={<Button size="sm" variant="secondary" onClick={add}><Plus size={14} aria-hidden /> {adminT('clouddrive.admin.preview.add')}</Button>}
          >
            <div className="flex flex-col gap-2">
              {drafts.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{adminT('clouddrive.admin.preview.none')}</p>}
              {drafts.map((draft, index) => (
                <div key={draft.id} className="flex flex-wrap items-end gap-2">
                  <label className="flex w-[136px] flex-col gap-1">
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{adminT('clouddrive.admin.preview.type')}</span>
                    <Select value={draft.type} onChange={(event) => update(index, { type: event.target.value as CloudDrivePreviewType })}>
                      {CLOUDDRIVE_PREVIEW_TYPES.map((type) => <option key={type} value={type}>{adminT(TYPE_LABEL_KEYS[type])}</option>)}
                    </Select>
                  </label>
                  <label className="flex min-w-[200px] flex-1 flex-col gap-1">
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{adminT('clouddrive.admin.preview.extensions')}</span>
                    <Input value={draft.extensions} onChange={(event) => update(index, { extensions: event.target.value })} placeholder={adminT('clouddrive.admin.preview.placeholder')} />
                  </label>
                  <label className="flex w-[92px] flex-col gap-1">
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{adminT('clouddrive.admin.preview.priority')}</span>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={String(draft.priority)}
                      onChange={(event) => update(index, { priority: Number(event.target.value) })}
                    />
                  </label>
                  <IconButton
                    label={adminT('clouddrive.admin.preview.remove')}
                    onClick={() => setDrafts((current) => current.filter((_, position) => position !== index))}
                  >
                    <Trash2 size={14} aria-hidden />
                  </IconButton>
                </div>
              ))}
            </div>
          </AdminCard>
        </div>
      )}
    </AdminPage>
  )
}
