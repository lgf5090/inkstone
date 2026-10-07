import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { PROPERTY_ICON_SIZE_RANGE, PROPERTY_BANNER_HEIGHT_RANGE, PROPERTY_COVER_WIDTH_RANGE } from '@shared/constants';
import { formatDateStamp } from '@shared/property-formats';
import { COVER_POSITIONS, COVER_SHAPES } from '@shared/property-decorations';
import type { PropertySettings } from '@shared/types';
import { t, useLocale, type MessageKey } from '../../lib/i18n';
import { renamedRule, withFormatRule, withName, withProgressRule, withSelectOptions } from '../../lib/property-prefs';
import { useSession } from '../../store/session';
import { Input, Select, SettingRow, Slider, Switch } from '../../components/form';
import { positionLabel, shapeLabel } from '../preview/PropertyDecorations';

const SHAPE_OPTIONS = COVER_SHAPES;

export function PropertiesSettings() {
    const properties = useSession(state => state.settings.properties);
    const update = useSession(state => state.updateSettings);
    const locale = useLocale();
    const patch = (next: Partial<PropertySettings>) => update({ properties: next });
    const now = Date.now();
    const dateSample = properties.dateFormat ? formatDateStamp(now, properties.dateFormat, locale) : '';
    const dateTimeSample = properties.dateTimeFormat ? formatDateStamp(now, properties.dateTimeFormat, locale) : '';
    return (<div className="space-y-6">
      <section>
        <Heading titleKey="settings.properties_group_general"/>
        <SettingRow title={t("settings.properties_enabled")} description={t("settings.properties_enabled_desc")}>
          <Switch checked={properties.enabled} onChange={value => patch({ enabled: value })} label={t("settings.properties_enabled")}/>
        </SettingRow>
        <SettingRow title={t("settings.properties_quick_search")} description={t("settings.properties_quick_search_desc")}>
          <Select aria-label={t("settings.properties_quick_search")} value={properties.quickSearchKey} onChange={event => patch({ quickSearchKey: event.target.value as PropertySettings['quickSearchKey'] })}>
            <option value="off">{t("settings.quick_search_off")}</option>
            <option value="ctrl">{t("settings.quick_search_ctrl")}</option>
            <option value="alt">{t("settings.quick_search_alt")}</option>
            <option value="meta">{t("settings.quick_search_meta")}</option>
          </Select>
        </SettingRow>
        <SettingRow title={t("settings.banner_property")} description={t("settings.decoration_property_desc")}>
          <Input aria-label={t("settings.banner_property")} value={properties.bannerProperty} onChange={event => patch({ bannerProperty: event.target.value })} className="w-40 font-mono"/>
        </SettingRow>
        <SettingRow title={t("settings.icon_property")} description={t("settings.decoration_property_desc")}>
          <Input aria-label={t("settings.icon_property")} value={properties.iconProperty} onChange={event => patch({ iconProperty: event.target.value })} className="w-40 font-mono"/>
        </SettingRow>
        <SettingRow title={t("settings.cover_properties")} description={t("settings.cover_properties_desc")}>
          <NameList names={properties.coverProperties} limit={8} onChange={next => patch({ coverProperties: next })} label={t("settings.cover_properties")}/>
        </SettingRow>
        <SettingRow title={t("settings.decoration_aux_names")} description={t("settings.decoration_aux_names_desc")}>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label={t("settings.cover_shape_property")} value={properties.coverShapeProperty} onChange={event => patch({ coverShapeProperty: event.target.value })} className="w-32 font-mono"/>
            <Input aria-label={t("settings.cover_position_property")} value={properties.coverPositionProperty} onChange={event => patch({ coverPositionProperty: event.target.value })} className="w-32 font-mono"/>
            <Input aria-label={t("settings.banner_position_property")} value={properties.bannerPositionProperty} onChange={event => patch({ bannerPositionProperty: event.target.value })} className="w-32 font-mono"/>
          </div>
        </SettingRow>
      </section>

      <section>
        <Heading titleKey="settings.properties_group_cover"/>
        <SettingRow title={t("settings.cover_show")} description={t("settings.cover_show_desc")}>
          <Switch checked={properties.showCover} onChange={value => patch({ showCover: value })} label={t("settings.cover_show")}/>
        </SettingRow>
        <SettingRow title={t("settings.cover_default_position")}>
          <Select aria-label={t("settings.cover_default_position")} value={properties.coverPosition} onChange={event => patch({ coverPosition: event.target.value as PropertySettings['coverPosition'] })}>
            {COVER_POSITIONS.map(position => <option key={position} value={position}>{positionLabel(position)}</option>)}
          </Select>
        </SettingRow>
        <SettingRow title={t("settings.cover_default_shape")}>
          <Select aria-label={t("settings.cover_default_shape")} value={properties.coverShape} onChange={event => patch({ coverShape: event.target.value as PropertySettings['coverShape'] })}>
            {SHAPE_OPTIONS.map(shape => <option key={shape} value={shape}>{shapeLabel(shape)}</option>)}
          </Select>
        </SettingRow>
        <SettingRow title={t("settings.cover_widths")} description={t("settings.cover_widths_desc")}>
          <div className="flex items-center gap-2">
            <NumberField ariaLabel={t("settings.cover_width_1")} value={properties.coverWidth} range={PROPERTY_COVER_WIDTH_RANGE} onChange={value => patch({ coverWidth: value })}/>
            <NumberField ariaLabel={t("settings.cover_width_2")} value={properties.coverWidth2} range={PROPERTY_COVER_WIDTH_RANGE} onChange={value => patch({ coverWidth2: value })}/>
            <NumberField ariaLabel={t("settings.cover_width_3")} value={properties.coverWidth3} range={PROPERTY_COVER_WIDTH_RANGE} onChange={value => patch({ coverWidth3: value })}/>
          </div>
        </SettingRow>
        <SettingRow title={t("settings.cover_max_height")} description={t("settings.cover_max_height_desc")}>
          <NumberField ariaLabel={t("settings.cover_max_height")} value={properties.coverMaxHeight} range={[PROPERTY_COVER_WIDTH_RANGE[0], 1600]} onChange={value => patch({ coverMaxHeight: value })}/>
        </SettingRow>
      </section>

      <section>
        <Heading titleKey="settings.properties_group_banner"/>
        <SettingRow title={t("settings.banner_show")}>
          <Switch checked={properties.showBanner} onChange={value => patch({ showBanner: value })} label={t("settings.banner_show")}/>
        </SettingRow>
        <SettingRow title={t("settings.banner_height")}>
          <Slider value={properties.bannerHeight} min={PROPERTY_BANNER_HEIGHT_RANGE[0]} max={PROPERTY_BANNER_HEIGHT_RANGE[1]} onChange={value => patch({ bannerHeight: value })} suffix={t("common.px")} label={t("settings.banner_height")}/>
        </SettingRow>
        <SettingRow title={t("settings.banner_fade")} description={t("settings.banner_fade_desc")}>
          <Switch checked={properties.bannerFade} onChange={value => patch({ bannerFade: value })} label={t("settings.banner_fade")}/>
        </SettingRow>
        <SettingRow title={t("settings.banner_default_focus")} description={t("settings.banner_default_focus_desc")}>
          <Slider value={properties.bannerPosition} min={0} max={100} onChange={value => patch({ bannerPosition: value })} suffix="%" label={t("settings.banner_default_focus")}/>
        </SettingRow>
      </section>

      <section>
        <Heading titleKey="settings.properties_group_icon"/>
        <SettingRow title={t("settings.icon_show")}>
          <Switch checked={properties.showIcon} onChange={value => patch({ showIcon: value })} label={t("settings.icon_show")}/>
        </SettingRow>
        <SettingRow title={t("settings.icon_size")}>
          <Slider value={properties.iconSize} min={PROPERTY_ICON_SIZE_RANGE[0]} max={PROPERTY_ICON_SIZE_RANGE[1]} onChange={value => patch({ iconSize: value })} suffix={t("common.px")} label={t("settings.icon_size")}/>
        </SettingRow>
        <SettingRow title={t("settings.icon_in_title")} description={t("settings.icon_in_title_desc")}>
          <Switch checked={properties.iconInline} onChange={value => patch({ iconInline: value })} label={t("settings.icon_in_title")}/>
        </SettingRow>
      </section>

      <section>
        <Heading titleKey="settings.properties_group_colours"/>
        <SettingRow title={t("settings.colored_values")} description={t("settings.colored_values_desc")}>
          <Switch checked={properties.coloredValues} onChange={value => patch({ coloredValues: value })} label={t("settings.colored_values")}/>
        </SettingRow>
        <SettingRow title={t("settings.date_formats")} description={t("settings.date_formats_desc")}>
          <Switch checked={properties.useCustomDateFormats} onChange={value => patch({ useCustomDateFormats: value })} label={t("settings.date_formats")}/>
        </SettingRow>
        <SettingRow title={t("settings.date_format")} description={dateSample || t("settings.date_format_hint")}>
          <Input aria-label={t("settings.date_format")} value={properties.dateFormat} placeholder={t("settings.date_format_placeholder")} onChange={event => patch({ dateFormat: event.target.value })} className="w-44 font-mono"/>
        </SettingRow>
        <SettingRow title={t("settings.date_time_format")} description={dateTimeSample || t("settings.date_format_hint")}>
          <Input aria-label={t("settings.date_time_format")} value={properties.dateTimeFormat} placeholder={t("settings.date_time_format_placeholder")} onChange={event => patch({ dateTimeFormat: event.target.value })} className="w-44 font-mono"/>
        </SettingRow>
        <SettingRow title={t("settings.relative_date_colors")} description={t("settings.relative_date_colors_desc")}>
          <div className="flex items-center gap-3">
            <Switch checked={properties.relativeDateColors} onChange={value => patch({ relativeDateColors: value })} label={t("settings.relative_date_colors")}/>
            <ColorField ariaLabel={t("settings.date_past_color")} value={properties.datePastColor} onChange={value => patch({ datePastColor: value })}/>
            <ColorField ariaLabel={t("settings.date_present_color")} value={properties.datePresentColor} onChange={value => patch({ datePresentColor: value })}/>
            <ColorField ariaLabel={t("settings.date_future_color")} value={properties.dateFutureColor} onChange={value => patch({ dateFutureColor: value })}/>
          </div>
        </SettingRow>
      </section>

      <section>
        <Heading titleKey="settings.properties_group_hidden"/>
        <SettingRow title={t("settings.reveal_hidden_properties")} description={t("settings.reveal_hidden_properties_desc")}>
          <Switch checked={properties.revealHidden} onChange={value => patch({ revealHidden: value })} label={t("settings.reveal_hidden_properties")}/>
        </SettingRow>
        <SettingRow title={t("settings.hide_all_empty")} description={t("settings.hide_all_empty_desc")}>
          <Switch checked={properties.hideAllEmpty} onChange={value => patch({ hideAllEmpty: value })} label={t("settings.hide_all_empty")}/>
        </SettingRow>
        <SettingRow title={t("settings.hidden_properties")} description={t("settings.hidden_properties_desc")}>
          <NameList names={properties.hidden} limit={80} onChange={next => patch({ hidden: next })} label={t("settings.hidden_properties")}/>
        </SettingRow>
        <SettingRow title={t("settings.hidden_when_empty_properties")} description={t("settings.hidden_when_empty_properties_desc")}>
          <NameList names={properties.hiddenWhenEmpty} limit={80} onChange={next => patch({ hiddenWhenEmpty: next })} label={t("settings.hidden_when_empty_properties")}/>
        </SettingRow>
        <SettingRow title={t("settings.hide_properties_header")} description={t("settings.hide_properties_header_desc")}>
          <Switch checked={properties.hideHeader} onChange={value => patch({ hideHeader: value })} label={t("settings.hide_properties_header")}/>
        </SettingRow>
        <SettingRow title={t("settings.hide_add_property_button")}>
          <Switch checked={properties.hideAddButton} onChange={value => patch({ hideAddButton: value })} label={t("settings.hide_add_property_button")}/>
        </SettingRow>
        <SettingRow title={t("settings.hide_block_when_all_hidden")} description={t("settings.hide_block_when_all_hidden_desc")}>
          <Switch checked={properties.hideWholeBlockWhenEmpty} onChange={value => patch({ hideWholeBlockWhenEmpty: value })} label={t("settings.hide_block_when_all_hidden")}/>
        </SettingRow>
      </section>

      <section>
        <Heading titleKey="settings.properties_group_rules"/>
        <SettingRow title={t("settings.property_formats")} description={t("settings.property_formats_desc")} className="items-start">
          <FormatRules rules={properties.formats} patch={next => patch({ formats: next })}/>
        </SettingRow>
        <SettingRow title={t("settings.property_progress")} description={t("settings.property_progress_desc")} className="items-start">
          <ProgressRules rules={properties.progress} patch={next => patch({ progress: next })}/>
        </SettingRow>
        <SettingRow title={t("settings.property_options")} description={t("settings.property_options_desc")} className="items-start">
          <OptionRules rules={properties.selectOptions} patch={next => patch({ selectOptions: next })}/>
        </SettingRow>
      </section>
    </div>);
}

function Heading({ titleKey }: {
    titleKey: MessageKey;
}) {
    return (<h3 data-setting-title={t(titleKey)} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {t(titleKey)}
      </h3>);
}

function NumberField({ ariaLabel, value, range, onChange }: {
    ariaLabel: string;
    value: number;
    range: readonly [number, number];
    onChange: (value: number) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const shown = draft ?? String(value);
    return (<Input aria-label={ariaLabel} type="number" inputMode="numeric" min={range[0]} max={range[1]} value={shown} onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (event.target.value !== '' && Number.isFinite(parsed))
            onChange(parsed);
    }} onBlur={() => setDraft(null)} className="w-20 tabular"/>);
}

function ColorField({ ariaLabel, value, onChange }: {
    ariaLabel: string;
    value: string | null;
    onChange: (value: string | null) => void;
}) {
    return (<label className="flex items-center gap-1.5">
        <span className="relative flex size-7 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)]">
          <span className="size-3.5 rounded-full" style={{ backgroundColor: value ?? 'transparent', boxShadow: value ? undefined : 'inset 0 0 0 1px var(--border-default)' }} aria-hidden="true"/>
          <input type="color" value={value ?? '#888888'} onChange={event => onChange(event.target.value.toLocaleLowerCase())} aria-label={ariaLabel} className="absolute inset-0 size-full cursor-pointer opacity-0"/>
        </span>
        {value && (<button type="button" aria-label={`${ariaLabel} · ${t('common.clear')}`} onClick={() => onChange(null)} className="text-[var(--text-quaternary)] hover:text-[var(--danger)]">
            <X size={11}/>
          </button>)}
      </label>);
}

function NameList({ names, limit, onChange, label }: {
    names: string[];
    limit: number;
    onChange: (names: string[]) => void;
    label: string;
}) {
    const [draft, setDraft] = useState('');
    const commit = () => {
        const name = draft.trim();
        setDraft('');
        if (name)
            onChange(withName(names, name, true).slice(0, limit));
    };
    return (<div role="group" aria-label={label} className="flex max-w-full flex-wrap items-center justify-end gap-1">
        {names.map(name => (<span key={name} className="flex max-w-full items-center rounded-[var(--r-sm)] bg-[var(--bg-inset)] py-0.5 pl-1.5 text-[11.5px] text-[var(--text-primary)]">
            <span className="truncate font-mono">{name}</span>
            <button type="button" aria-label={`${name} · ${t('common.remove')}`} onClick={() => onChange(withName(names, name, false))} className="flex size-5 items-center justify-center text-[var(--text-quaternary)] hover:text-[var(--danger)]">
              <X size={10}/>
            </button>
          </span>))}
        {!names.length && <span className="text-[11.5px] text-[var(--text-quaternary)]">{t('settings.list_empty')}</span>}
        <Input aria-label={t('settings.list_add')} value={draft} placeholder={t('settings.list_add')} onChange={event => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit();
            }
        }} onBlur={commit} className="w-28 font-mono"/>
      </div>);
}

function RuleShell({ label, children, onAdd }: {
    label: string;
    children: React.ReactNode;
    onAdd: () => void;
}) {
    return (<div role="group" aria-label={label} className="flex w-full max-w-full flex-col items-stretch gap-1.5 md:w-80">
        {children}
        <button type="button" onClick={onAdd} className="flex items-center gap-1 self-start rounded px-1.5 py-1 text-[11.5px] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
          <Plus size={11}/>
          <span>{t('settings.rule_add')}</span>
        </button>
      </div>);
}

function RuleRow({ name, onRename, onRemove, children }: {
    name: string;
    onRename: (next: string) => void;
    onRemove: () => void;
    children: React.ReactNode;
}) {
    return (<div className="flex items-center gap-1.5">
        <Input aria-label={t('settings.rule_property')} value={name} onChange={event => onRename(event.target.value)} className="w-24 shrink-0 font-mono"/>
        {children}
        <button type="button" aria-label={t('settings.rule_remove')} onClick={onRemove} className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--danger)]">
          <X size={11}/>
        </button>
      </div>);
}

function EmptyRule({ label }: {
    label: string;
}) {
    return <span className="text-[11.5px] text-[var(--text-quaternary)]">{label}</span>;
}

function FormatRules({ rules, patch }: {
    rules: PropertySettings['formats'];
    patch: (next: PropertySettings['formats']) => void;
}) {
    const entries = Object.entries(rules);
    return (<RuleShell label={t('settings.property_formats')} onAdd={() => patch(withFormatRule(rules, newRuleName(entries), { template: '{{propertyValue}}' }))}>
        {!entries.length && <EmptyRule label={t('settings.rules_empty')}/>}
        {entries.map(([name, rule]) => (<RuleRow key={name} name={name} onRename={(next) => patch(renamedRule(rules, name, next, rule))} onRemove={() => patch(withFormatRule(rules, name, null))}>
              <Input aria-label={name + ' · ' + t('settings.property_formats')} value={rule.template ?? ''} placeholder={t('settings.format_placeholder')} onChange={event => patch(withFormatRule(rules, name, { template: event.target.value }))} className="min-w-0 flex-1 font-mono text-[11px]"/>
              <Switch checked={rule.markdown === true} onChange={value => patch(withFormatRule(rules, name, { markdown: value }))} label={name + ' · ' + t('properties.markdown_on')}/>
            </RuleRow>))}
      </RuleShell>);
}

function ProgressRules({ rules, patch }: {
    rules: PropertySettings['progress'];
    patch: (next: PropertySettings['progress']) => void;
}) {
    const entries = Object.entries(rules);
    return (<RuleShell label={t('settings.property_progress')} onAdd={() => patch(withProgressRule(rules, newRuleName(entries), { max: 100 }))}>
        {!entries.length && <EmptyRule label={t('settings.rules_empty')}/>}
        {entries.map(([name, rule]) => (<RuleRow key={name} name={name} onRename={(next) => patch(renamedRule(rules, name, next, rule))} onRemove={() => patch(withProgressRule(rules, name, null))}>
              <Input aria-label={name + ' · ' + t('settings.progress_max')} type="text" inputMode="numeric" value={rule.maxProperty ?? String(rule.max ?? 100)} onChange={(event) => {
                const value = event.target.value.trim();
                const asNumber = Number(value);
                const variant = rule.variant;
                patch(withProgressRule(rules, name, value && Number.isFinite(asNumber) && asNumber !== 0
                  ? { max: asNumber, variant }
                  : { maxProperty: value, variant }));
            }} className="w-20 shrink-0 font-mono"/>
              <Select aria-label={name + ' · ' + t('settings.progress_variant')} value={rule.variant ?? 'bar'} onChange={event => patch(withProgressRule(rules, name, {
                max: rule.max,
                maxProperty: rule.maxProperty,
                variant: event.target.value === 'circle' ? 'circle' : undefined,
            }))} className="w-24 shrink-0">
                <option value="bar">{t('settings.progress_bar_label')}</option>
                <option value="circle">{t('settings.progress_circle_label')}</option>
              </Select>
            </RuleRow>))}
      </RuleShell>);
}

function OptionRules({ rules, patch }: {
    rules: PropertySettings['selectOptions'];
    patch: (next: PropertySettings['selectOptions']) => void;
}) {
    const entries = Object.entries(rules);
    return (<RuleShell label={t('settings.property_options')} onAdd={() => patch(withSelectOptions(rules, newRuleName(entries), ['1', '2', '3']))}>
        {!entries.length && <EmptyRule label={t('settings.rules_empty')}/>}
        {entries.map(([name, options]) => (<RuleRow key={name} name={name} onRename={(next) => patch(renamedRule(rules, name, next, options))} onRemove={() => patch(withSelectOptions(rules, name, null))}>
              <Input aria-label={name + ' · ' + t('settings.property_options')} value={options.join(', ')} placeholder={t('settings.options_placeholder')} onChange={event => patch(withSelectOptions(rules, name, event.target.value.split(/[,\uFF0C]/)))} className="min-w-0 flex-1 font-mono text-[11px]"/>
            </RuleRow>))}
      </RuleShell>);
}

function newRuleName(entries: Array<[string, unknown]>): string {
    const taken = new Set(entries.map(([name]) => name.toLocaleLowerCase()));
    let index = 1;
    while (taken.has(`property-${index}`))
        index += 1;
    return `property-${index}`;
}
