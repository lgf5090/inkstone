/**
 * Every rule has to be nameable.
 *
 * The rule list, the settings search and the toast that names what changed all speak by rule title,
 * so two rules wearing the same name are indistinguishable to a reader — and, as a probe found here
 * the hard way, indistinguishable to whoever writes the test that clicks one of them. The reference
 * plugin's Chinese catalogue carried two collisions; this is what keeps them from coming back.
 */
import { describe, expect, it } from 'vitest';
import { EN_US_MESSAGES } from '@shared/locales/en-US';
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN';
import type { MessageKey } from '../../i18n';
import { rules } from '../registry';

const catalogues = [['en-US', EN_US_MESSAGES], ['zh-CN', ZH_CN_MESSAGES]] as const

// The keys a rule is named by are private to the class; this gate reads them as data, which is what
// the settings search index does too.
function keysOf(rule: (typeof rules)[number]): { nameKey: MessageKey, descriptionKey: MessageKey } {
  return rule as unknown as { nameKey: MessageKey, descriptionKey: MessageKey }
}

describe('rule titles', () => {
  for (const [language, catalogue] of catalogues) {
    it(`names every rule differently in ${language}`, () => {
      const byTitle = new Map<string, string[]>()
      for (const rule of rules) {
        const title = catalogue[keysOf(rule).nameKey as keyof typeof catalogue]
        byTitle.set(title, [...(byTitle.get(title) ?? []), rule.alias])
      }

      expect([...byTitle].filter(([, aliases]) => aliases.length > 1)).toEqual([]);
    });

    it(`says something different about every rule in ${language}`, () => {
      const described = rules.map((rule) => [rule.alias, catalogue[keysOf(rule).descriptionKey as keyof typeof catalogue]] as const);
      const missing = described.filter(([, text]) => !text || text.startsWith('linter.')).map(([alias]) => alias)

      expect(missing).toEqual([]);
    });
  }
});
