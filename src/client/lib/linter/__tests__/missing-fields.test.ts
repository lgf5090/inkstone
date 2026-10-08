import { describe, expect, it } from 'vitest';

import {rules} from '../rules';
import '../registry';

describe('Check missing fields', () => {
  for (const rule of rules) {
    it(rule.getName(), () => {
      expect(rule.getName()).toBeTruthy();
      expect(rule.getDescription()).toBeTruthy();
      expect(rule.examples.length).toBeGreaterThan(0);
    });
  }
});
