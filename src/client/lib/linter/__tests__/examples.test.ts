import { describe, expect, test } from 'vitest';

import dedent from 'ts-dedent';
import {Example, rules, RuleType} from '../rules';
import {yamlRegex, escapeRegExp} from '../engine/regex';
import '../registry';
import {defaultMisspellings} from './misspellings';

describe('Examples pass', () => {
  for (const rule of rules) {
    describe(rule.getName(), () => {
      test.each(rule.examples)('$description', (example: Example) => {
        const options = example.options;
        // add default misspellings for auto-correct
        if (rule.alias == 'auto-correct-common-misspellings') {
          (options as Record<string, unknown>).misspellingToCorrection = defaultMisspellings();
        }

        expect(rule.apply(example.before, options)).toBe(example.after);
      });
    });
  }
});

describe('Augmented examples pass', () => {
  for (const rule of rules) {
    describe(rule.getName(), () => {
      test.each(rule.examples)('$description', (example: Example) => {
        // Add YAML
        if (rule.type !== RuleType.YAML && rule.type !== RuleType.PASTE && !example.before.match(yamlRegex)) {
          const yaml = dedent`
            ---
            foo: bar
            ---
            ${''}
          `;

          const before = yaml + example.before;

          const options = example.options;
          // add default misspellings for auto-correct
          if (rule.alias == 'auto-correct-common-misspellings') {
            (options as Record<string, unknown>).misspellingToCorrection = defaultMisspellings();
          }

          expect(rule.apply(before, options)).toMatch(new RegExp(`${escapeRegExp(yaml)}\n?${escapeRegExp(example.after)}`));
        }
      });
    });
  }
});
