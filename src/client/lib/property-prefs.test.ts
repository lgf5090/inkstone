import { describe, expect, it } from 'vitest';
import { mergeSettings } from '@shared/constants';
import type { PropertySettings } from '@shared/types';
import { withColor, withFormatRule, withName, withProgressRule, withSelectOptions } from './property-prefs';

function settings(patch: Partial<PropertySettings> = {}): PropertySettings {
    return mergeSettings({ properties: patch }).properties;
}

describe('withName', () => {
    it('refuses to hide the same property twice, whatever the spelling', () => {
        expect(withName(['Draft'], 'draft', true)).toEqual(['Draft']);
        expect(withName(['Draft'], 'status', true)).toEqual(['Draft', 'status']);
        expect(withName(['Draft'], 'DRAFT', false)).toEqual([]);
    });

    it('ignores a blank name', () => {
        expect(withName(['a'], '   ', true)).toEqual(['a']);
    });
});

describe('withColor', () => {
    it('keeps the other values of the same property', () => {
        const base = settings({ colors: { status: { done: { pill: '#059669' }, todo: { text: '#dc2626' } } } });
        const next = withColor(base, 'status', 'done', 'text', '#2563eb');
        expect(next.status).toEqual({ done: { pill: '#059669', text: '#2563eb' }, todo: { text: '#dc2626' } });
    });

    it('folds the property name but keeps the value as written', () => {
        const next = withColor(settings(), 'Status', 'Done', 'pill', '#059669');
        expect(Object.keys(next)).toEqual(['status']);
        expect(Object.keys(next.status!)).toEqual(['Done']);
    });

    it('drops the value once both slots are back to the theme', () => {
        const base = settings({ colors: { status: { done: { pill: '#059669' } } } });
        expect(withColor(base, 'status', 'done', 'pill', null).status).toBeUndefined();
        expect(withColor(base, 'status', 'done', 'pill', 'default').status).toBeUndefined();
    });

    it('keeps none as its own answer', () => {
        const next = withColor(settings(), 'status', 'done', 'pill', 'none');
        expect(next.status!.done).toEqual({ pill: 'none' });
    });

    it('leaves the map alone when the property or the value is blank', () => {
        const base = settings({ colors: { status: { done: { pill: '#059669' } } } });
        expect(withColor(base, '', 'done', 'pill', '#059669')).toBe(base.colors);
        expect(withColor(base, 'status', '  ', 'pill', '#059669')).toBe(base.colors);
    });

    it('does not mutate the settings it was given', () => {
        const base = settings({ colors: { status: { done: { pill: '#059669' } } } });
        const snapshot = JSON.stringify(base.colors);
        withColor(base, 'other', 'x', 'pill', '#2563eb');
        expect(JSON.stringify(base.colors)).toBe(snapshot);
    });
});

describe('withProgressRule', () => {
    it('replaces, keeps the rest, and removes on null', () => {
        const base = settings({ progress: { pages: { max: 100 }, minutes: { max: 30 } } });
        expect(withProgressRule(base, 'pages', { max: 250, variant: 'circle' })).toEqual({ pages: { max: 250, variant: 'circle' }, minutes: { max: 30 } });
        expect(withProgressRule(base, 'pages', null)).toEqual({ minutes: { max: 30 } });
    });
});

describe('withFormatRule', () => {
    it('merges a markdown flag into an existing template rule', () => {
        const base = settings({ formats: { length: { template: '{{upper propertyValue}}' } } });
        expect(withFormatRule(base, 'length', { markdown: true })).toEqual({ length: { template: '{{upper propertyValue}}', markdown: true } });
    });

    it('drops a blank template but keeps the template when only markdown goes off', () => {
        const base = settings({ formats: { length: { template: '{{upper propertyValue}}', markdown: true } } });
        expect(withFormatRule(base, 'length', { template: '   ' })).toEqual({ length: { markdown: true } });
        expect(withFormatRule(base, 'length', { markdown: false })).toEqual({ length: { template: '{{upper propertyValue}}' } });
        expect(withFormatRule(base, 'length', null)).toEqual({});
    });
});

describe('withSelectOptions', () => {
    it('trims, folds duplicates and keeps the order', () => {
        const next = withSelectOptions(settings(), 'status', [' a ', 'A', 'b', '']);
        expect(next.status).toEqual(['a', 'b']);
    });

    it('removes the rule for an empty list or null', () => {
        const base = settings({ selectOptions: { status: ['a'] } });
        expect(withSelectOptions(base, 'status', [])).toEqual({});
        expect(withSelectOptions(base, 'status', null)).toEqual({});
    });
});
