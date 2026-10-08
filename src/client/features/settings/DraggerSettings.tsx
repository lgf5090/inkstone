import { useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Plus, X } from 'lucide-react'
import {
  DRAGGER_MENU_ROOT_IDS,
  DRAGGER_AUTO_SCROLL_EDGE_RANGE,
  DRAGGER_AUTO_SCROLL_SPEED_RANGE,
  DRAGGER_HANDLE_GLYPH_MAX,
  DRAGGER_HANDLE_OFFSET_RANGE,
  DRAGGER_HANDLE_SIZE_RANGE,
  DRAGGER_MOBILE_ARM_RANGE,
  DRAGGER_MULTI_SELECT_RANGE,
  DRAGGER_CONTENT_TOKEN,
} from '@shared/constants'
import type {
  DraggerBlockStyle,
  DraggerColorMode,
  DraggerGutterSide,
  DraggerHandleIcon,
  DraggerHandleVisibility,
  DraggerMenuOrders,
  DraggerSelectionStyle,
  EditorSettings,
} from '@shared/types'
import { Button } from '../../components/primitives'
import { Input, Segmented, SettingRow, Slider, Switch, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { useMediaQuery } from '../../lib/hooks'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { draggerBlockMenuEntries, isDraggerMenuGroup } from '../../editor/dragger/menu-entries'

type Patch = Partial<EditorSettings>

/**
 * The reader's side of the dragger: what the handle looks like, how a drag is armed, and what the
 * handle's menu offers.
 *
 * Every row writes through the account settings, and the editor repaints from custom properties on
 * the document root, so no row here needs an editor reload — except the rail's side, which the
 * editor reconfigures for.
 */
export function DraggerSettings() {
  const editor = useSession((s) => s.settings.editor)
  const update = useSession((s) => s.updateSettings)
  const touch = useMediaQuery('(pointer: coarse)')
  const set = (patch: Patch) => void update({ editor: patch })
  const [styleDraft, setStyleDraft] = useState<DraggerBlockStyle | 'new' | null>(null)
  return (<div className="space-y-6">
    <section>
      <h3 data-setting-title={t('settings.dragger_group')} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('settings.dragger_group')}</h3>

      <SettingRow title={t('settings.dragger')} description={t('settings.dragger_hint')}>
        <Switch checked={editor.dragger} onChange={(dragger) => set({ dragger })} label={t('settings.dragger')}/>
      </SettingRow>

      {editor.dragger && <>
        <DraggerHandlePreview/>

        <SettingRow title={t('settings.dragger_handles')}>
          <Segmented<DraggerHandleVisibility> label={t('settings.dragger_handles')} value={editor.draggerHandles} onChange={(draggerHandles) => set({ draggerHandles })} options={[
            { value: 'hover', label: t('settings.dragger_handles_hover') },
            { value: 'always', label: t('settings.dragger_handles_always') },
            { value: 'hidden', label: t('settings.dragger_handles_hidden') },
          ]}/>
        </SettingRow>

        <SettingRow title={t('settings.dragger_handle_icon')}>
          <Segmented<DraggerHandleIcon> label={t('settings.dragger_handle_icon')} value={editor.draggerHandleIcon} onChange={(draggerHandleIcon) => set({ draggerHandleIcon })} options={[
            { value: 'dot', label: t('settings.dragger_icon_dot') },
            { value: 'grip-dots', label: t('settings.dragger_icon_grip_dots') },
            { value: 'grip-lines', label: t('settings.dragger_icon_grip_lines') },
            { value: 'square', label: t('settings.dragger_icon_square') },
            { value: 'custom', label: t('settings.dragger_icon_custom') },
          ]}/>
        </SettingRow>

        {editor.draggerHandleIcon === 'custom' && (<SettingRow title={t('settings.dragger_handle_glyph')} description={t('settings.dragger_handle_glyph_hint')}>
            <Input aria-label={t('settings.dragger_handle_glyph')} value={editor.draggerHandleGlyph} maxLength={DRAGGER_HANDLE_GLYPH_MAX} className="w-24 text-center text-[18px]" onChange={(event) => set({ draggerHandleGlyph: event.target.value })}/>
          </SettingRow>)}

        <SettingRow title={t('settings.dragger_handle_size')}>
          <Slider label={t('settings.dragger_handle_size')} className="w-[200px]" value={editor.draggerHandleSize} min={DRAGGER_HANDLE_SIZE_RANGE[0]} max={DRAGGER_HANDLE_SIZE_RANGE[1]} step={2} onChange={(draggerHandleSize) => set({ draggerHandleSize })} suffix="px"/>
        </SettingRow>

        <SettingRow title={t('settings.dragger_handle_offset')} description={t('settings.dragger_handle_offset_hint')}>
          <Slider label={t('settings.dragger_handle_offset')} className="w-[200px]" value={editor.draggerHandleOffset} min={DRAGGER_HANDLE_OFFSET_RANGE[0]} max={DRAGGER_HANDLE_OFFSET_RANGE[1]} onChange={(draggerHandleOffset) => set({ draggerHandleOffset })} suffix="px"/>
        </SettingRow>

        <SettingRow title={t('settings.dragger_handle_side')}>
          <Segmented<DraggerGutterSide> label={t('settings.dragger_handle_side')} value={editor.draggerHandleSide} onChange={(draggerHandleSide) => set({ draggerHandleSide })} options={[
            { value: 'left', label: t('settings.dragger_side_left') },
            { value: 'right', label: t('settings.dragger_side_right') },
          ]}/>
        </SettingRow>

        <SettingRow title={t('settings.dragger_handle_color')}>
          <div className="flex items-center gap-2">
            <Segmented<DraggerColorMode> label={t('settings.dragger_handle_color')} value={editor.draggerHandleColorMode} onChange={(draggerHandleColorMode) => set({ draggerHandleColorMode })} options={[
              { value: 'theme', label: t('settings.dragger_color_theme') },
              { value: 'custom', label: t('settings.dragger_color_custom') },
            ]}/>
            {editor.draggerHandleColorMode === 'custom' && <ColorDot ariaLabel={t('settings.dragger_handle_color')} value={editor.draggerHandleColor} onChange={(draggerHandleColor) => set({ draggerHandleColor })}/>}
          </div>
        </SettingRow>

        <SettingRow title={t('settings.dragger_indicator_color')}>
          <div className="flex items-center gap-2">
            <Segmented<DraggerColorMode> label={t('settings.dragger_indicator_color')} value={editor.draggerIndicatorColorMode} onChange={(draggerIndicatorColorMode) => set({ draggerIndicatorColorMode })} options={[
              { value: 'theme', label: t('settings.dragger_color_theme') },
              { value: 'custom', label: t('settings.dragger_color_custom') },
            ]}/>
            {editor.draggerIndicatorColorMode === 'custom' && <ColorDot ariaLabel={t('settings.dragger_indicator_color')} value={editor.draggerIndicatorColor} onChange={(draggerIndicatorColor) => set({ draggerIndicatorColor })}/>}
          </div>
        </SettingRow>

        <SettingRow title={t('settings.dragger_highlight')}>
          <Switch checked={editor.draggerHighlight} onChange={(draggerHighlight) => set({ draggerHighlight })} label={t('settings.dragger_highlight')}/>
        </SettingRow>

        <SettingRow title={t('settings.dragger_selection_style')}>
          <Segmented<DraggerSelectionStyle> label={t('settings.dragger_selection_style')} value={editor.draggerSelectionStyle} onChange={(draggerSelectionStyle) => set({ draggerSelectionStyle })} options={[
            { value: 'outline', label: t('settings.dragger_style_outline') },
            { value: 'subtle', label: t('settings.dragger_style_subtle') },
            { value: 'filled', label: t('settings.dragger_style_filled') },
          ]}/>
        </SettingRow>
      </>}
    </section>

    {editor.dragger && (<section>
        <h3 data-setting-title={t('settings.dragger_menu_group')} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('settings.dragger_menu_group')}</h3>

        <SettingRow title={t('settings.dragger_multi_select')} description={t('settings.dragger_multi_select_hint')}>
          <Switch checked={editor.draggerMultiSelect} onChange={(draggerMultiSelect) => set({ draggerMultiSelect })} label={t('settings.dragger_multi_select')}/>
        </SettingRow>

        {editor.draggerMultiSelect && (<SettingRow title={t('settings.dragger_multi_select_ms')} description={t('settings.dragger_multi_select_ms_hint')}>
            <Slider label={t('settings.dragger_multi_select_ms')} className="w-[200px]" value={editor.draggerMultiSelectMs} min={DRAGGER_MULTI_SELECT_RANGE[0]} max={DRAGGER_MULTI_SELECT_RANGE[1]} step={10} onChange={(draggerMultiSelectMs) => set({ draggerMultiSelectMs })} suffix="ms"/>
          </SettingRow>)}

        <SettingRow title={t('settings.dragger_menu_order')} description={t('settings.dragger_menu_order_hint')}>
          <DraggerOrderEditor settings={editor} onChange={set}/>
        </SettingRow>

        <SettingRow title={t('settings.dragger_block_styles')} description={t('settings.dragger_block_styles_hint')}>
          <div className="flex flex-wrap items-center gap-1.5">
            {editor.draggerBlockStyles.map((style) => (<span key={style.id} className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-1.5 py-0.5 text-[var(--text-11)]">
                <button type="button" onClick={() => setStyleDraft(style)} aria-label={`${t('settings.dragger_style_edit')} · ${style.label}`} className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  {style.icon && <span aria-hidden="true">{style.icon}</span>}
                  {style.label}
                </button>
                <button type="button" aria-label={`${t('common.remove')} · ${style.label}`} onClick={() => void removeStyle(style, editor, set)} className="text-[var(--text-quaternary)] hover:text-[var(--danger)]">
                  <X size={11}/>
                </button>
              </span>))}
            <Button variant="ghost" size="sm" icon={<Plus size={13}/>} onClick={() => setStyleDraft('new')}>{t('settings.dragger_style_add')}</Button>
          </div>
        </SettingRow>
      </section>)}

    {editor.dragger && (<section>
        <h3 data-setting-title={t('settings.dragger_behavior')} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('settings.dragger_behavior')}</h3>

        <SettingRow title={t('settings.dragger_auto_scroll')} description={t('settings.dragger_auto_scroll_hint')}>
          <Switch checked={editor.draggerAutoScroll} onChange={(draggerAutoScroll) => set({ draggerAutoScroll })} label={t('settings.dragger_auto_scroll')}/>
        </SettingRow>

        {editor.draggerAutoScroll && (<>
            <SettingRow title={t('settings.dragger_auto_scroll_edge')}>
              <Slider label={t('settings.dragger_auto_scroll_edge')} className="w-[200px]" value={editor.draggerAutoScrollEdge} min={DRAGGER_AUTO_SCROLL_EDGE_RANGE[0]} max={DRAGGER_AUTO_SCROLL_EDGE_RANGE[1]} step={4} onChange={(draggerAutoScrollEdge) => set({ draggerAutoScrollEdge })} suffix="px"/>
            </SettingRow>
            <SettingRow title={t('settings.dragger_auto_scroll_speed')}>
              <Slider label={t('settings.dragger_auto_scroll_speed')} className="w-[200px]" value={editor.draggerAutoScrollSpeed} min={DRAGGER_AUTO_SCROLL_SPEED_RANGE[0]} max={DRAGGER_AUTO_SCROLL_SPEED_RANGE[1]} step={2} onChange={(draggerAutoScrollSpeed) => set({ draggerAutoScrollSpeed })} suffix="px"/>
            </SettingRow>
          </>)}

        <SettingRow title={t('settings.dragger_move_keys')} description={t('settings.dragger_move_keys_hint')}>
          <Switch checked={editor.draggerMoveKeys} onChange={(draggerMoveKeys) => set({ draggerMoveKeys })} label={t('settings.dragger_move_keys')}/>
        </SettingRow>

        {touch && (<>
            <SettingRow title={t('settings.dragger_mobile_text_drag')} description={t('settings.dragger_mobile_text_drag_hint')}>
              <Switch checked={editor.draggerMobileTextDrag} onChange={(draggerMobileTextDrag) => {
                set({ draggerMobileTextDrag })
                if (!draggerMobileTextDrag) useUi.getState().setDraggerDragMode(false)
              }} label={t('settings.dragger_mobile_text_drag')}/>
            </SettingRow>

            {editor.draggerMobileTextDrag && (<>
                <SettingRow title={t('settings.dragger_mobile_arm_ms')} description={t('settings.dragger_mobile_arm_ms_hint')}>
                  <Slider label={t('settings.dragger_mobile_arm_ms')} className="w-[200px]" value={editor.draggerMobileArmMs} min={DRAGGER_MOBILE_ARM_RANGE[0]} max={DRAGGER_MOBILE_ARM_RANGE[1]} step={10} onChange={(draggerMobileArmMs) => set({ draggerMobileArmMs })} suffix="ms"/>
                </SettingRow>
                <SettingRow title={t('settings.dragger_exit_after_drop')}>
                  <Switch checked={editor.draggerExitDragModeAfterDrop} onChange={(draggerExitDragModeAfterDrop) => set({ draggerExitDragModeAfterDrop })} label={t('settings.dragger_exit_after_drop')}/>
                </SettingRow>
              </>)}
          </>)}
      </section>)}

    {styleDraft !== null && (<DraggerBlockStyleDialog draft={styleDraft} onClose={() => setStyleDraft(null)} onSave={(next) => {
      set({
        draggerBlockStyles: styleDraft === 'new' ? [...editor.draggerBlockStyles, next] : editor.draggerBlockStyles.map((style) => style.id === next.id ? next : style),
        draggerMenuOrders: styleDraft === 'new'
          ? { ...editor.draggerMenuOrders, custom: [...editor.draggerMenuOrders.custom.filter((id) => id !== next.id), next.id] }
          : editor.draggerMenuOrders,
      })
      setStyleDraft(null)
    }}/>)}
  </div>)
}

/** The handle as the reader is choosing it, drawn from the same custom properties the editor uses. */
function DraggerHandlePreview() {
  return (<div className="mb-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1">
      <div className="ink-dragger-sample">
        <div className="md-dragger-handle is-visible" role="presentation"><span className="ink-dragger-handle-core" aria-hidden="true"/></div>
        <span className="ink-dragger-sample-body">{t('settings.dragger_sample_text')}</span>
      </div>
    </div>)
}

function ColorDot({ ariaLabel, value, onChange }: { ariaLabel: string; value: string; onChange: (value: string) => void }) {
  return (<label className="relative flex size-7 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)]">
      <span className="size-3.5 rounded-full" style={{ backgroundColor: value }} aria-hidden="true"/>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value.toLocaleLowerCase())} aria-label={ariaLabel} className="absolute inset-0 size-full cursor-pointer opacity-0"/>
    </label>)
}

/**
 * The handle menu's own rows, in the reader's order.
 *
 * Nothing can be deleted here — a menu that lost a command would leave the reader unable to make a
 * heading again — so the rows only move, and the default is one button away.
 */
function DraggerOrderEditor({ settings, onChange }: { settings: EditorSettings; onChange: (patch: Patch) => void }) {
  const [open, setOpen] = useState(false)
  const entries = draggerBlockMenuEntries(settings)
  const orders = settings.draggerMenuOrders
  const move = (list: keyof DraggerMenuOrders, index: number, delta: -1 | 1) => {
    const next = [...orders[list]]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const moved = next.splice(index, 1)[0]
    next.splice(target, 0, moved)
    onChange({ draggerMenuOrders: { ...orders, [list]: next } })
  }
  return (<div className="relative">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1 text-[var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
        <span>{entries.map((entry) => entry.label).join(' · ')}</span>
        <ChevronRight size={13} className={open ? 'rotate-90 transition-transform' : 'transition-transform'} aria-hidden="true"/>
      </button>
      {open && (<div className="absolute right-0 z-[var(--z-pop)] mt-1 w-[min(92vw,420px)] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]">
          <OrderList label={t('settings.dragger_menu_order')} ids={orders.root} names={new Map(entries.map((entry) => [entry.id, entry.label]))} onMove={(index, delta) => move('root', index, delta)} onReset={() => onChange({ draggerMenuOrders: defaultOrders(orders) })}/>
          {(['heading', 'list', 'callout'] as const).map((group) => {
        const entriesFor = entries.find((entry) => isDraggerMenuGroup(entry) && entry.id === group)
        const names = new Map(entriesFor && isDraggerMenuGroup(entriesFor)
            ? entriesFor.options.map((option) => [option.id, option.label])
            : [])
        return (<OrderList key={group} label={entriesFor?.label ?? group} ids={orders[group]} names={names} onMove={(index, delta) => move(group, index, delta)}/>)
      })}
        </div>)}
    </div>)
}

function OrderList({ label, ids, names, onMove, onReset }: {
  label: string
  ids: string[]
  names: Map<string, string>
  onMove: (index: number, delta: -1 | 1) => void
  onReset?: () => void
}) {
  return (<div className="mb-2 last:mb-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[var(--text-11)] font-semibold text-[var(--text-tertiary)]">{label}</span>
        {onReset && (<button type="button" onClick={onReset} className="text-[var(--text-11)] text-[var(--text-quaternary)] hover:text-[var(--text-primary)]">{t('settings.dragger_menu_default')}</button>)}
      </div>
      <ol className="space-y-0.5">
        {ids.map((id, index) => (<li key={id} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[var(--text-12)] text-[var(--text-secondary)]">{names.get(id) ?? id}</span>
            <button type="button" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`${t('settings.dragger_menu_up')} · ${names.get(id) ?? id}`} className="rounded-[var(--r-2)] p-0.5 text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] disabled:opacity-30"><ArrowUp size={13}/></button>
            <button type="button" disabled={index === ids.length - 1} onClick={() => onMove(index, 1)} aria-label={`${t('settings.dragger_menu_down')} · ${names.get(id) ?? id}`} className="rounded-[var(--r-2)] p-0.5 text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] disabled:opacity-30"><ArrowDown size={13}/></button>
          </li>))}
      </ol>
    </div>)
}

async function removeStyle(style: DraggerBlockStyle, settings: EditorSettings, onChange: (patch: Patch) => void): Promise<void> {
  const ok = await confirm({
    title: t('settings.dragger_style_edit'),
    description: `${style.label} · ${t('settings.dragger_block_styles_hint')}`,
    confirmLabel: t('common.remove'),
    tone: 'danger',
  })
  if (!ok) return
  const orders = settings.draggerMenuOrders
  onChange({
    draggerBlockStyles: settings.draggerBlockStyles.filter((candidate) => candidate.id !== style.id),
    draggerMenuOrders: { ...orders, custom: orders.custom.filter((id) => id !== style.id) },
  })
}

/** The canonical root order, with the reader's own submenus kept. */
function defaultOrders(orders: DraggerMenuOrders): DraggerMenuOrders {
  return { ...orders, root: [...DRAGGER_MENU_ROOT_IDS] }
}

export function DraggerBlockStyleDialog({ draft, onClose, onSave }: {
  draft: DraggerBlockStyle | 'new'
  onClose: () => void
  onSave: (style: DraggerBlockStyle) => void
}) {
  const [style, setStyle] = useState<DraggerBlockStyle>(draft === 'new'
    ? { id: `style-${Date.now().toString(36)}`, label: '', icon: '✨', template: `:::panel\n${DRAGGER_CONTENT_TOKEN}\n:::` }
    : { variables: undefined, linePrefix: undefined, ...draft })
  const [error, setError] = useState<string | null>(null)
  const commit = () => {
    const label = style.label.trim()
    if (!label) {
      setError(t('settings.dragger_style_error_label'))
      return
    }
    if (!style.template.includes(DRAGGER_CONTENT_TOKEN)) {
      setError(t('settings.dragger_style_error_token'))
      return
    }
    const names = Object.keys(style.variables ?? {})
    if (names.some((name) => name === 'content' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
      || new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
      setError(t('settings.dragger_style_error_name'))
      return
    }
    onSave({ ...style, label, icon: Array.from(style.icon).slice(0, 8).join('') })
  }
  return (<Modal open onClose={onClose} title={draft === 'new' ? t('settings.dragger_style_new') : t('settings.dragger_style_edit')} width={520} footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={commit}>{t('common.save')}</Button></>}>
      <div className="space-y-3">
        <FieldRow label={t('settings.dragger_style_label_field')}>
          <Input aria-label={t('settings.dragger_style_label_field')} value={style.label} onChange={(event) => setStyle({ ...style, label: event.target.value })}/>
        </FieldRow>
        <FieldRow label={t('settings.dragger_style_icon_field')}>
          <Input aria-label={t('settings.dragger_style_icon_field')} value={style.icon} maxLength={8} className="w-16 text-center" onChange={(event) => setStyle({ ...style, icon: event.target.value })}/>
        </FieldRow>
        <FieldRow label={t('settings.dragger_style_template_field')} hint={t('settings.dragger_style_template_hint')}>
          <Textarea aria-label={t('settings.dragger_style_template_field')} rows={4} className="font-mono text-[var(--text-12)]" value={style.template} onChange={(event) => setStyle({ ...style, template: event.target.value })}/>
        </FieldRow>
        <FieldRow label={t('settings.dragger_style_prefix_field')} hint={t('settings.dragger_style_prefix_hint')}>
          <Input aria-label={t('settings.dragger_style_prefix_field')} maxLength={8} className="w-20 font-mono" value={style.linePrefix ?? ''} onChange={(event) => setStyle({ ...style, linePrefix: event.target.value || undefined })}/>
        </FieldRow>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[var(--text-11)] font-semibold text-[var(--text-tertiary)]">{t('settings.dragger_style_variables_field')}</span>
            <Button variant="ghost" size="sm" icon={<Plus size={12}/>} onClick={() => setStyle({ ...style, variables: { ...(style.variables ?? {}), [`v${Object.keys(style.variables ?? {}).length + 1}`]: '' } })}>{t('settings.dragger_style_variable_add')}</Button>
          </div>
          {Object.entries(style.variables ?? {}).map(([name, value]) => (<div key={name} className="mb-1 flex items-center gap-1.5">
              <Input aria-label={t('settings.dragger_style_label_field')} value={name} className="w-28 font-mono text-[var(--text-12)]" onChange={(event) => setStyle(renameVariable(style, name, event.target.value))}/>
              <Input aria-label={t('settings.dragger_style_value_field')} value={value} className="min-w-0 flex-1 font-mono text-[var(--text-12)]" onChange={(event) => setStyle({ ...style, variables: { ...(style.variables ?? {}), [name]: event.target.value } })}/>
              <button type="button" aria-label={`${t('common.remove')} · ${name}`} onClick={() => {
                const next = { ...(style.variables ?? {}) }
                delete next[name]
                setStyle({ ...style, variables: next })
              }} className="text-[var(--text-quaternary)] hover:text-[var(--danger)]"><X size={12}/></button>
            </div>))}
        </div>
        {error && <p className="text-[var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>)
}

function renameVariable(style: DraggerBlockStyle, from: string, to: string): DraggerBlockStyle {
  const variables = { ...(style.variables ?? {}) }
  delete variables[from]
  variables[to] = variables[to] ?? ''
  return { ...style, variables }
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (<label className="block">
      <span className="mb-1 block text-[var(--text-12)] font-medium text-[var(--text-secondary)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[var(--text-11)] text-[var(--text-quaternary)]">{hint}</span>}
    </label>)
}
