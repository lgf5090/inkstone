import type { ReactNode } from 'react';
import { BarChart3, Circle, Eye, EyeOff, Palette, Search, Sparkles, Type } from 'lucide-react';
import type { MenuItem } from '../../components/overlay';
import { prompt, submenuFor } from '../../components/overlay';
import type { PropertySettings } from '@shared/types';
import type { ResolvedProperty } from '@shared/property-style';
import { t } from '../../lib/i18n';
import { withColor, withFormatRule, withName, withProgressRule, withSelectOptions } from '../../lib/property-prefs';
import { PropertyColorPanel } from './property-colors';

export interface PropertyMenuHandlers {
    settings: PropertySettings;
    patch: (patch: Partial<PropertySettings>) => void;
    numericProperties: string[];
    onSearch: (value: string) => void;
    onRename: () => void;
    onDelete: () => void;
}

function colorSubmenu(handlers: PropertyMenuHandlers, property: string, value: string, slot: 'pill' | 'text'): (context: { closeMenu: () => void }) => ReactNode {
    const stored = handlers.settings.colors[property.toLocaleLowerCase()]?.[value];
    const current = slot === 'pill' ? stored?.pill ?? null : stored?.text ?? null;
    return () => (<PropertyColorPanel label={slot === 'pill' ? t('properties.pill_color') : t('properties.text_color')} current={typeof current === 'string' ? current : null} tinted={slot === 'pill'} onPick={(color) => {
        handlers.patch({ colors: withColor(handlers.settings, property, value, slot, color) });
    }}/>);
}

export function buildPillMenu(property: string, value: string, handlers: PropertyMenuHandlers): MenuItem[] {
    const hidden = handlers.settings.hidden.some(item => item.toLocaleLowerCase() === property.toLocaleLowerCase());
    return [
        {
            id: 'pill-color',
            label: t('properties.pill_color'),
            icon: <Palette size={14}/>,
            submenu: colorSubmenu(handlers, property, value, 'pill'),
        },
        {
            id: 'pill-text-color',
            label: t('properties.text_color'),
            icon: <Type size={14}/>,
            submenu: colorSubmenu(handlers, property, value, 'text'),
        },
        {
            id: 'pill-search',
            label: t('properties.search_value'),
            icon: <Search size={14}/>,
            onSelect: () => handlers.onSearch(value),
        },
        {
            id: 'pill-hide',
            label: hidden ? t('properties.unhide') : t('properties.hide'),
            icon: hidden ? <Eye size={14}/> : <EyeOff size={14}/>,
            separatorBefore: true,
            onSelect: () => handlers.patch({ hidden: withName(handlers.settings.hidden, property, !hidden) }),
        },
    ];
}

async function editTemplate(property: string, current: string | null | undefined, handlers: PropertyMenuHandlers): Promise<void> {
    const answer = await prompt({
        title: t('properties.format_title', { name: property }),
        description: t('properties.format_hint'),
        defaultValue: current ?? '',
        confirmLabel: t('common.apply'),
    });
    if (answer === null)
        return;
    handlers.patch({ formats: withFormatRule(handlers.settings, property, { template: answer }) });
}

async function editOptions(property: string, current: readonly string[], handlers: PropertyMenuHandlers): Promise<void> {
    const answer = await prompt({
        title: t('properties.options_title', { name: property }),
        description: t('properties.options_hint'),
        defaultValue: current.join(', '),
        confirmLabel: t('common.apply'),
    });
    if (answer === null)
        return;
    handlers.patch({ selectOptions: withSelectOptions(handlers.settings, property, answer.split(/[,\uFF0C]/)) });
}

export function buildPropertyMenu(row: ResolvedProperty, handlers: PropertyMenuHandlers): MenuItem[] {
    const key = row.key.toLocaleLowerCase();
    const settings = handlers.settings;
    const hidden = settings.hidden.some(item => item.toLocaleLowerCase() === key);
    const hiddenWhenEmpty = settings.hiddenWhenEmpty.some(item => item.toLocaleLowerCase() === key);
    const progress = settings.progress[key];
    const format = settings.formats[key];
    const items: MenuItem[] = [
        {
            id: 'hide',
            label: hidden ? t('properties.unhide') : t('properties.hide'),
            icon: hidden ? <Eye size={14}/> : <EyeOff size={14}/>,
            onSelect: () => handlers.patch({ hidden: withName(settings.hidden, row.key, !hidden) }),
        },
        {
            id: 'hide-empty',
            label: hiddenWhenEmpty ? t('properties.stop_hiding_when_empty') : t('properties.hide_when_empty'),
            icon: hiddenWhenEmpty ? <Eye size={14}/> : <EyeOff size={14}/>,
            onSelect: () => handlers.patch({ hiddenWhenEmpty: withName(settings.hiddenWhenEmpty, row.key, !hiddenWhenEmpty) }),
        },
    ];
    if (row.items.length === 1 && row.display) {
        items.push({
            id: 'search',
            label: t('properties.search_value'),
            icon: <Search size={14}/>,
            onSelect: () => handlers.onSearch(row.display),
        });
    }
    if (row.kind === 'number') {
        if (!progress) {
            items.push({
                id: 'progress-bar',
                label: t('properties.progress_bar'),
                icon: <BarChart3 size={14}/>,
                separatorBefore: true,
                onSelect: () => handlers.patch({ progress: withProgressRule(settings, row.key, { max: 100 }) }),
            });
            items.push({
                id: 'progress-circle',
                label: t('properties.progress_circle'),
                icon: <Circle size={14}/>,
                onSelect: () => handlers.patch({ progress: withProgressRule(settings, row.key, { max: 100, variant: 'circle' }) }),
            });
        }
        else {
            const sources = handlers.numericProperties.filter(name => name.toLocaleLowerCase() !== key);
            const maxItems: MenuItem[] = [
                ...sources.map(name => ({
                    id: `progress-max-${name}`,
                    label: name,
                    checked: progress.maxProperty?.toLocaleLowerCase() === name.toLocaleLowerCase(),
                    onSelect: () => handlers.patch({ progress: withProgressRule(settings, row.key, { maxProperty: name, variant: progress.variant }) }),
                })),
                {
                    id: 'progress-max-number',
                    label: t('properties.progress_max_number'),
                    onSelect: async () => {
                        const answer = await prompt({
                            title: t('properties.progress_max_number', { name: row.key }),
                            defaultValue: String(progress.max ?? 100),
                        });
                        const parsed = Number(answer?.trim());
                        if (answer === null || !Number.isFinite(parsed) || parsed === 0)
                            return;
                        handlers.patch({ progress: withProgressRule(settings, row.key, { max: parsed, variant: progress.variant }) });
                    },
                },
                {
                    id: 'progress-max-default',
                    label: t('properties.progress_max_percent'),
                    checked: progress.maxProperty === undefined && progress.max === 100,
                    onSelect: () => handlers.patch({ progress: withProgressRule(settings, row.key, { max: 100, variant: progress.variant }) }),
                },
            ];
            items.push({
                id: 'progress-max',
                label: t('properties.progress_max'),
                icon: <BarChart3 size={14}/>,
                separatorBefore: true,
                subItems: maxItems,
                submenu: submenuFor(maxItems),
            });
            items.push({
                id: 'progress-remove',
                label: t('properties.progress_remove'),
                icon: <BarChart3 size={14}/>,
                onSelect: () => handlers.patch({ progress: withProgressRule(settings, row.key, null) }),
            });
        }
    }
    if (row.kind === 'text' || row.kind === 'number') {
        items.push({
            id: 'format',
            label: format?.template ? t('properties.format_edit') : t('properties.format_add'),
            icon: <Sparkles size={14}/>,
            separatorBefore: true,
            onSelect: () => void editTemplate(row.key, format?.template, handlers),
        });
        if (format?.template) {
            items.push({
                id: 'format-remove',
                label: t('properties.format_remove'),
                icon: <Sparkles size={14}/>,
                onSelect: () => handlers.patch({ formats: withFormatRule(settings, row.key, null) }),
            });
        }
        items.push({
            id: 'markdown',
            label: format?.markdown ? t('properties.markdown_off') : t('properties.markdown_on'),
            icon: <Type size={14}/>,
            checked: format?.markdown === true,
            onSelect: () => handlers.patch({ formats: withFormatRule(settings, row.key, { markdown: format?.markdown !== true }) }),
        });
        items.push({
            id: 'options',
            label: row.options.length ? t('properties.options_edit') : t('properties.options_add'),
            onSelect: () => void editOptions(row.key, row.options, handlers),
        });
        if (row.options.length) {
            items.push({
                id: 'options-remove',
                label: t('properties.options_remove'),
                onSelect: () => handlers.patch({ selectOptions: withSelectOptions(settings, row.key, null) }),
            });
        }
    }
    if (row.kind !== 'object') {
        items.push({
            id: 'rename',
            label: t('properties.rename'),
            separatorBefore: true,
            onSelect: handlers.onRename,
        });
        items.push({
            id: 'delete',
            label: t('properties.delete'),
            tone: 'danger',
            onSelect: handlers.onDelete,
        });
    }
    return items;
}
