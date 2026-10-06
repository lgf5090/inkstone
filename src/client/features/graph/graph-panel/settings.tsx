import { useId, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  Download,
  Filter,
  Network,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { LIMITS } from '@shared/constants'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import { truncateText } from '@shared/text-utils'
import type { Folder, Tag } from '@shared/types'
import { Button, IconButton } from '../../../components/primitives'
import { Select, Segmented, Slider, Switch } from '../../../components/form'
import { Drawer } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { randomLocalId } from '../../../lib/random-id'
import {
  GRAPH_APPEARANCE_TOGGLES,
  GRAPH_COLOR_GROUP_LIMIT,
  GRAPH_DEPTHS,
  GRAPH_EXPORT_TOGGLES,
  GRAPH_FORCE_RANGES,
  GRAPH_LINK_DIRECTIONS,
  GRAPH_LIMIT_STEP,
  GRAPH_SHOW_TOGGLES,
  type GraphColorGroup,
  type GraphLinkDirection,
  type GraphPreferences,
  type GroupBy,
} from '../../../lib/graph-settings'
import { GRAPH_COLOR_QUERY_MAX, GRAPH_COLOR_SWATCH_MAX } from './constants'

export interface GraphSettingsPanelProps {
  prefs: GraphPreferences
  onPref: <K extends keyof GraphPreferences>(key: K, value: GraphPreferences[K]) => void
  folders: readonly Folder[]
  tags: readonly Tag[]
  open: boolean
  onClose: () => void
  onRestoreDefaults: () => void
}

export function GraphSettingsPanel({
  prefs, onPref, folders, tags, open, onClose, onRestoreDefaults,
}: GraphSettingsPanelProps) {
  return <Drawer open={open} onClose={onClose} title={t('graph.settings')} width={300} zIndex={235}>
    <div className="p-4">
      <GraphFilterSection prefs={prefs} onPref={onPref} folders={folders} tags={tags}/>
      <GraphAppearanceSection prefs={prefs} onPref={onPref}/>
      <GraphExportSection prefs={prefs} onPref={onPref}/>
      <GraphForceSection prefs={prefs} onPref={onPref} onRestoreDefaults={onRestoreDefaults}/>
    </div>
  </Drawer>
}

function GraphFilterSection({ prefs, onPref, folders, tags }: {
  prefs: GraphPreferences
  onPref: GraphSettingsPanelProps['onPref']
  folders: readonly Folder[]
  tags: readonly Tag[]
}) {
  const known = tags.map((tag) => tag.name)
  const active = prefs.tags.filter((name) => known.includes(name))
  return <GraphSection icon={<Filter size={13}/>} title={t('graph.filters')}>
    <GraphRow label={t('graph.folder')}>
      <Select aria-label={t('graph.folder')} className="max-w-[160px]" value={prefs.folderId}
        onChange={(event) => onPref('folderId', event.target.value)}>
        <option value="">{t('graph.all_folders')}</option>
        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </Select>
    </GraphRow>
    {tags.length > 0 && <div className="text-[12px] text-[var(--text-secondary)]">
      <span className="mb-1.5 block">{t('graph.tag')}</span>
      <div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto">
        {tags.map((tag) => <TagChip key={tag.name} name={tag.name} active={active.includes(tag.name)}
          onToggle={() => onPref('tags', toggleTag(active, tag.name))}/>)}
      </div>
    </div>}
    {active.length > 1 && <GraphRow label={t('graph.tags_match')}>
      <Segmented size="sm" label={t('graph.tags_match')} value={prefs.tagsMatch}
        onChange={(value) => onPref('tagsMatch', value)}
        options={[
          { value: 'any' as const, label: t('graph.tags_match_any') },
          { value: 'all' as const, label: t('graph.tags_match_all') },
        ]}/>
    </GraphRow>}
    {GRAPH_SHOW_TOGGLES.map((control) => <GraphRow key={control.prefKey} label={t(control.labelKey)}>
      <Switch label={t(control.labelKey)} checked={prefs[control.prefKey]}
        onChange={(value) => onPref(control.prefKey, value)}/>
    </GraphRow>)}
    {prefs.excludedNoteIds.length > 0 && <div className="flex items-center justify-between gap-2">
      <span className="text-[11.5px] text-[var(--text-tertiary)]">
        {t('graph.excluded_notes', { value: prefs.excludedNoteIds.length })}
      </span>
      <Button size="sm" variant="ghost" onClick={() => onPref('excludedNoteIds', [])}>
        {t('graph.restore_all_notes')}
      </Button>
    </div>}
    {prefs.mode === 'local' && <GraphRow label={t('graph.depth')}>
      <Segmented size="sm" label={t('graph.depth')} value={String(prefs.depth)}
        onChange={(value) => onPref('depth', Number(value))}
        options={GRAPH_DEPTHS.map((depth) => ({ value: String(depth), label: String(depth) }))}/>
    </GraphRow>}
    {prefs.mode === 'local' && <GraphRow label={t('graph.link_direction')}>
      <Select aria-label={t('graph.link_direction')} className="max-w-[160px]" value={prefs.direction}
        onChange={(event) => onPref('direction', event.target.value as GraphLinkDirection)}>
        {GRAPH_LINK_DIRECTIONS.map((option) => <option key={option.value} value={option.value}>
          {t(option.labelKey)}
        </option>)}
      </Select>
    </GraphRow>}
    <Slider label={t('graph.node_limit')} min={LIMITS.graphNodeLimitMin} max={LIMITS.graphNodeLimitMax}
      step={GRAPH_LIMIT_STEP} value={prefs.limit} onChange={(value) => onPref('limit', value)}/>
  </GraphSection>
}

function toggleTag(list: readonly string[], name: string): string[] {
  return list.includes(name)
    ? list.filter((item) => item !== name)
    : [...list, name].slice(0, LIMITS.graphTagsMax)
}

function GraphAppearanceSection({ prefs, onPref }: {
  prefs: GraphPreferences
  onPref: GraphSettingsPanelProps['onPref']
}) {
  return <GraphSection icon={<Network size={13}/>} title={t('graph.appearance')}>
    <GraphRow label={t('graph.group_by')}>
      <Select aria-label={t('graph.group_by')} className="max-w-[160px]" value={prefs.groupBy}
        onChange={(event) => onPref('groupBy', event.target.value as GroupBy)}>
        <option value="none">{t('graph.group_none')}</option>
        <option value="folder">{t('graph.folder')}</option>
        <option value="tag">{t('graph.tag')}</option>
      </Select>
    </GraphRow>
    <GraphColorRules groups={prefs.colorGroups} onChange={(value) => onPref('colorGroups', value)}/>
    {GRAPH_APPEARANCE_TOGGLES.map((control) => <GraphRow key={control.prefKey} label={t(control.labelKey)}>
      <Switch label={t(control.labelKey)} checked={prefs[control.prefKey]}
        onChange={(value) => onPref(control.prefKey, value)}/>
    </GraphRow>)}
  </GraphSection>
}

function GraphColorRules({ groups, onChange }: {
  groups: readonly GraphColorGroup[]
  onChange: (value: GraphColorGroup[]) => void
}) {
  const update = (id: string, patch: Partial<GraphColorGroup>) => {
    onChange(groups.map((group) => group.id === id ? { ...group, ...patch } : group))
  }
  return <div className="space-y-2.5">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-[var(--text-secondary)]">{t('graph.color_rules')}</span>
      <IconButton size="sm" label={t('graph.add_color_rule')} disabled={groups.length >= GRAPH_COLOR_GROUP_LIMIT}
        onClick={() => onChange([...groups, {
          id: randomLocalId('rule'),
          query: '',
          color: ORGANIZER_COLORS[groups.length % ORGANIZER_COLORS.length],
        }])}>
        <Plus size={13}/>
      </IconButton>
    </div>
    {groups.map((group) => <ColorRuleRow key={group.id} group={group}
      onChange={(patch) => update(group.id, patch)}
      onRemove={() => onChange(groups.filter((item) => item.id !== group.id))}/>)}
  </div>
}

function ColorRuleRow({ group, onChange, onRemove }: {
  group: GraphColorGroup
  onChange: (patch: Partial<GraphColorGroup>) => void
  onRemove: () => void
}) {
  const labelId = useId()
  return <div className="space-y-1.5">
    <div className="flex items-center gap-1.5">
      <label htmlFor={labelId} className="sr-only">{t('graph.color_rule_query')}</label>
      <input id={labelId} type="text" value={group.query} placeholder={t('graph.color_rule_query_hint')}
        onChange={(event) => onChange({ query: truncateText(event.target.value, GRAPH_COLOR_QUERY_MAX) })}
        className="h-8 min-w-0 flex-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[12px] outline-none placeholder:text-[var(--text-tertiary)]"/>
      <IconButton size="sm" label={t('common.delete')} onClick={onRemove}><Trash2 size={12}/></IconButton>
    </div>
    <div className="flex flex-wrap items-center gap-1">
      {ORGANIZER_COLORS.slice(0, GRAPH_COLOR_SWATCH_MAX).map((color) => <button key={color} type="button"
        aria-label={color} aria-pressed={group.color === color} title={color}
        onClick={() => onChange({ color })}
        className="size-3.5 shrink-0 rounded-full border border-[var(--border-default)] aria-pressed:ring-2 aria-pressed:ring-[var(--accent)]"
        style={{ background: color }}/>)}
    </div>
  </div>
}

function GraphExportSection({ prefs, onPref }: {
  prefs: GraphPreferences
  onPref: GraphSettingsPanelProps['onPref']
}) {
  return <GraphSection icon={<Download size={13}/>} title={t('graph.export_options')}>
    {GRAPH_EXPORT_TOGGLES.map((control) => <GraphRow key={control.prefKey} label={t(control.labelKey)}>
      <Switch label={t(control.labelKey)} checked={prefs[control.prefKey]}
        onChange={(value) => onPref(control.prefKey, value)}/>
    </GraphRow>)}
  </GraphSection>
}

function GraphForceSection({ prefs, onPref, onRestoreDefaults }: {
  prefs: GraphPreferences
  onPref: GraphSettingsPanelProps['onPref']
  onRestoreDefaults: () => void
}) {
  return <GraphSection icon={<ArrowRight size={13}/>} title={t('graph.forces')}>
    {GRAPH_FORCE_RANGES.map((control) => <Slider key={control.prefKey} label={t(control.labelKey)}
      min={control.min} max={control.max} step={control.step} value={prefs[control.prefKey]}
      onChange={(value) => onPref(control.prefKey, value)}/>)}
    <button type="button" onClick={onRestoreDefaults}
      className="mt-1 flex h-8 w-full items-center justify-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
      <ArrowDownToLine size={13}/>{t('graph.restore_defaults')}
    </button>
  </GraphSection>
}

function TagChip({ name, active, onToggle }: { name: string; active: boolean; onToggle: () => void }) {
  return <button type="button" onClick={onToggle} aria-pressed={active}
    className="flex h-6 max-w-full items-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] aria-pressed:border-[var(--accent)] aria-pressed:text-[var(--accent)]">
    <span className="min-w-0 truncate">{name}</span>
    {active && <X size={10} className="shrink-0"/>}
  </button>
}

function GraphRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]">
    <span className="min-w-0 truncate">{label}</span>
    <span className="flex min-w-0 shrink-0 items-center">{children}</span>
  </div>
}

function GraphSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <section className="mb-5">
    <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-tertiary)]">
      {icon}{title}
    </h4>
    <div className="space-y-2.5">{children}</div>
  </section>
}
