import { useMemo } from 'react';
import { parseFrontMatter } from '@shared/markdown-utils';
import { DEFAULT_PROPERTY_NAMES, readNoteDecorations } from '@shared/property-decorations';
import type { DecorationDefaults, NoteDecorations, NotePropertyNames } from '@shared/property-decorations';
import { resolveProperties } from '@shared/property-style';
import type { PropertyStyleSettings, ResolvedProperty } from '@shared/property-style';
import type { PropertySettings } from '@shared/types';
import { useSession } from '../store/session';
import { getLocale, useLocaleRepaint } from './i18n';
import { useNotes } from '../store/notes';
import { tagKey } from '@shared/markdown-utils';

export function styleSettingsOf(properties: PropertySettings): PropertyStyleSettings {
    return {
        enabled: properties.enabled,
        colors: properties.colors,
        hidden: properties.hidden,
        hiddenWhenEmpty: properties.hiddenWhenEmpty,
        hideAllEmpty: properties.hideAllEmpty,
        customDateFormats: properties.useCustomDateFormats,
        dateFormat: properties.dateFormat,
        dateTimeFormat: properties.dateTimeFormat,
        relativeDateColors: properties.relativeDateColors,
        dateColors: {
            past: properties.datePastColor,
            present: properties.datePresentColor,
            future: properties.dateFutureColor,
        },
        progress: properties.progress,
        formats: properties.formats,
        selectOptions: properties.selectOptions,
    };
}

export function decorationNamesOf(properties: PropertySettings): NotePropertyNames {
    if (!properties.enabled)
        return { ...DEFAULT_PROPERTY_NAMES, banner: '', icon: '', cover: [] };
    return {
        banner: properties.bannerProperty,
        icon: properties.iconProperty,
        cover: properties.coverProperties.filter(Boolean),
        coverShape: properties.coverShapeProperty,
        coverPosition: properties.coverPositionProperty,
        bannerPosition: properties.bannerPositionProperty,
    };
}

export function decorationDefaultsOf(properties: PropertySettings): DecorationDefaults {
    return {
        coverShape: properties.coverShape,
        coverPosition: properties.coverPosition,
        bannerPosition: properties.bannerPosition,
    };
}

export interface PropertyView {
    rows: ResolvedProperty[];
    decorations: NoteDecorations;
    errors: string[];
    names: NotePropertyNames;
    data: Record<string, unknown>;
}

export function usePropertyView(content: string): PropertyView {
    useLocaleRepaint();
    const properties = useSession(state => state.settings.properties);
    const tags = useNotes(state => state.tags);
    const style = useMemo(() => styleSettingsOf(properties), [properties]);
    const names = useMemo(() => decorationNamesOf(properties), [properties]);
    const defaults = useMemo(() => decorationDefaultsOf(properties), [properties]);
    const tagColors = useMemo(() => new Map(tags.map(tag => [tagKey(tag.name), tag.color])), [tags]);
    return useMemo(() => {
        const parsed = parseFrontMatter(content);
        const context = {
            locale: getLocale(),
            now: Date.now(),
            tagColorOf: (name: string) => tagColors.get(tagKey(name)) ?? null,
        };
        return {
            rows: resolveProperties(parsed.data, style, context),
            decorations: readNoteDecorations(parsed.data, names, defaults),
            errors: parsed.errors,
            names,
            data: parsed.data,
        };
    }, [content, style, names, defaults, tagColors]);
}

export function usePropertySettings(): PropertySettings {
    return useSession(state => state.settings.properties);
}
