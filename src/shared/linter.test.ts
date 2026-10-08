/**
 * The settings blob's boundary.
 *
 * A reader can bring this object into the app from a backup restore as well as from the settings
 * page, and the panel's own refusals are not in the way then. So everything that a lint run will
 * later compile or iterate is checked here: the shape, the size, and the flags. A value the
 * normaliser cannot recognise is dropped rather than passed on, because the alternative is a stored
 * string reaching `new RegExp` or a rule's option.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINTER_SETTINGS,
  LINTER_LIMITS,
  normalizeLinterSettings,
  isLinterIgnoredPath,
} from './linter';

describe('normalizeLinterSettings', () => {
  it('answers a non-object with the defaults', () => {
    expect(normalizeLinterSettings(null)).toEqual(DEFAULT_LINTER_SETTINGS);
    expect(normalizeLinterSettings('lint on save')).toEqual(DEFAULT_LINTER_SETTINGS);
    expect(normalizeLinterSettings([{ enabled: true }])).toEqual(DEFAULT_LINTER_SETTINGS);
  });

  it('keeps a recognised date locale and drops an invented one', () => {
    expect(normalizeLinterSettings({ localeOverride: 'zh-CN' }).localeOverride).toBe('zh-CN');
    expect(normalizeLinterSettings({ localeOverride: 'fr' }).localeOverride).toBe(DEFAULT_LINTER_SETTINGS.localeOverride);
    expect(normalizeLinterSettings({ localeOverride: 42 }).localeOverride).toBe('');
  });

  it('keeps an idle delay the panel could have offered', () => {
    expect(normalizeLinterSettings({ lintOnIdle: 15000 }).lintOnIdle).toBe(15000);
    expect(normalizeLinterSettings({ lintOnIdle: 1 }).lintOnIdle).toBe(0);
    expect(normalizeLinterSettings({ lintOnIdle: '5000' }).lintOnIdle).toBe(0);
  });

  it('bounds the rule configs by count', () => {
    const flooded: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < LINTER_LIMITS.rulesStored + 40; index++) {
      flooded[`rule-${index}`] = { enabled: true };
    }

    expect(Object.keys(normalizeLinterSettings({ ruleConfigs: flooded }).ruleConfigs).length).toBe(LINTER_LIMITS.rulesStored);
  });

  it('keeps the keys and values a rule could have declared', () => {
    const normalized = normalizeLinterSettings({
      ruleConfigs: { 'evil rule': { 'proto:polluter': 1, ok_key: 'x'.repeat(2000), enabled: 'yes', list: ['a', '', 7, 'b'] } },
    });

    // Every value is checked for the kind it is, not against the type the rule declared: the worker
    // has no rule library to ask, and a rule reads `enabled: 'yes'` as "not switched on" anyway.
    expect(normalized.ruleConfigs['evil rule']).toEqual({
      ok_key: 'x'.repeat(LINTER_LIMITS.optionValueChars),
      enabled: 'yes',
      list: ['a', 'b'],
    });
  });

  it('keeps only the regex flags a pattern can carry', () => {
    const [entry] = normalizeLinterSettings({ customRegexes: [{ find: 'a', replace: 'b', flags: 'ggiimsuyz', enabled: true }] }).customRegexes;
    expect(entry.flags).toBe('gimsuy');
    expect(entry.enabled).toBe(true);
  });

  it('trims a stored pattern to the budget rather than keeping it whole', () => {
    const [entry] = normalizeLinterSettings({ filesToIgnore: [{ label: 'l', match: 'a'.repeat(5000), flags: 'i' }] }).filesToIgnore;
    expect(entry.match.length).toBe(LINTER_LIMITS.fileMatchChars);
  });

  it('drops a file list that is not a list of objects', () => {
    expect(normalizeLinterSettings({ filesToIgnore: 'everything' }).filesToIgnore).toEqual([]);
    expect(normalizeLinterSettings({ foldersToIgnore: ['  a ', 'a', '', 3, 'b'] }).foldersToIgnore).toEqual(['a', 'b']);
  });
});

describe('isLinterIgnoredPath', () => {
  const base = { ...DEFAULT_LINTER_SETTINGS };

  it('leaves a note alone because of its folder or a parent of it', () => {
    const settings = { ...base, foldersToIgnore: ['Archive'] };
    expect(isLinterIgnoredPath(settings, 'Archive/old note', ['Journal', 'Archive'])).toBe(true);
    expect(isLinterIgnoredPath(settings, 'Journal/now', ['Journal'])).toBe(false);
  });

  it('matches the file pattern against the path', () => {
    const settings = { ...base, filesToIgnore: [{ label: '', match: '^Journal/', flags: '' }] };
    expect(isLinterIgnoredPath(settings, 'Journal/now', [])).toBe(true);
    expect(isLinterIgnoredPath(settings, 'Notes/Journal/now', [])).toBe(false);
  });

  it('refuses a pattern that could hang the run instead of testing it', () => {
    const settings = { ...base, filesToIgnore: [{ label: '', match: '(a+)+$', flags: '' }] };
    expect(isLinterIgnoredPath(settings, `${'a'.repeat(80)}b`, [])).toBe(false);
  });

  it('survives a pattern that does not compile', () => {
    const settings = { ...base, filesToIgnore: [{ label: '', match: '(', flags: '' }] };
    expect(isLinterIgnoredPath(settings, 'anything', [])).toBe(false);
  });
});
