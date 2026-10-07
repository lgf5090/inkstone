import { useMemo } from 'react';
import { parseFrontMatter, tagKey } from '@shared/markdown-utils';
import { readNoteDecorations } from '@shared/property-decorations';
import type { NoteDecorations, NotePropertyNames } from '@shared/property-decorations';
import { decorationDefaultsOf, decorationNamesOf, resolveProperties, styleSettingsOf } from '@shared/property-style';
import type { ResolvedProperty } from '@shared/property-style';
import type { PropertySettings, Tag } from '@shared/types';
import type { PropertyRenderOptions } from './markdown/renderer';
import { useSession } from '../store/session';
import { useNotes } from '../store/notes';
import { getLocale, useLocaleRepaint } from './i18n';

export { decorationDefaultsOf, decorationNamesOf, styleSettingsOf };

export function buildPropertyRenderOptions(properties: PropertySettings, tags: readonly Tag[]): PropertyRenderOptions {
    const colors = new Map(tags.map(tag => [tagKey(tag.name), tag.color]));
    return {
        style: styleSettingsOf(properties),
        names: decorationNamesOf(properties),
        defaults: decorationDefaultsOf(properties),
        revealHidden: properties.revealHidden,
        iconInline: properties.iconInline,
        iconSize: properties.iconSize,
        bannerHeight: properties.bannerHeight,
        bannerFade: properties.bannerFade,
        coverWidths: {
            width1: properties.coverWidth,
            width2: properties.coverWidth2,
            width3: properties.coverWidth3,
        },
        locale: getLocale(),
        tagColorOf: colors.size ? (name: string) => colors.get(tagKey(name)) ?? null : undefined,
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
