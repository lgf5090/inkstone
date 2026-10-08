/**
 * The rule list, as the reader operates it.
 *
 * The important part of switching a rule on is what happens to the rule it fights with: the panel
 * asks, the reader agrees, and both switches have to end up where the reader left them in a single
 * write. A second write built from the settings the first render saw would hand the rival its switch
 * back — the defect this file exists to keep out. Rule titles come from the registry rather than the
 * source, so the assertions are about the label a reader is shown, in whatever language is loaded.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants';
import type { LinterSettings as LinterSettingsValue } from '@shared/linter';
import { initI18n } from '../../lib/i18n';
import { rules } from '../../lib/linter/registry';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { LinterSettings } from './LinterSettings';

type ConfirmOptions = { title: string, description?: unknown, confirmLabel?: string };
const confirmRequests: ConfirmOptions[] = [];
let confirmAnswer = true;

vi.mock('../../components/overlay', async (original) => ({
  ...(await original<typeof import('../../components/overlay')>()),
  confirm: (options: ConfirmOptions) => {
    confirmRequests.push(options);
    return Promise.resolve(confirmAnswer);
  },
}));

let root: Root;
let container: HTMLDivElement;
let patches: Array<Record<string, unknown>>;

function titleOf(alias: string): string {
  const rule = rules.find((candidate) => candidate.alias === alias);
  if (!rule) throw new Error(`the registry has no ${alias}`);

  return rule.getName();
}

function setLinter(linter: Partial<LinterSettingsValue>): void {
  useSession.setState({ settings: mergeSettings({ linter: { ...DEFAULT_SETTINGS.linter, ...linter } }) });
}

function render(): void {
  act(() => {
    root.render(createElement(LinterSettings));
  });
}

/** The rule rows arrive when the panel's dynamic import of the library resolves. */
async function ruleRowsRendered(): Promise<void> {
  await act(async () => {
    await import('../../lib/linter/registry');
  });
  for (let round = 0; round < 60 && document.querySelectorAll('button[role="switch"]').length < rules.length; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function switchOf(name: string): HTMLElement {
  const nodes = [...document.querySelectorAll('button[role="switch"], input[type="checkbox"]')];
  const control = nodes.find((node) => (node.getAttribute('aria-label') ?? '') === name);
  if (!control) {
    throw new Error(`no switch named ${name}; saw ${nodes.length} of them`);
  }

  return control as HTMLElement;
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  confirmRequests.length = 0;
  confirmAnswer = true;
  patches = [];
  await initI18n();
  useSession.setState({
    settings: mergeSettings({ linter: DEFAULT_SETTINGS.linter }),
    updateSettings: (patch: Record<string, unknown>) => {
      patches.push(patch);
      useSession.setState({ settings: mergeSettings(patch) });
      return Promise.resolve();
    },
  });
  useUi.setState({ toast: () => '' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('switching a rule on', () => {
  it('names both rules in the conflict question', async () => {
    setLinter({ ruleConfigs: { 'paragraph-blank-lines': { enabled: true } } });
    render();
    await ruleRowsRendered();

    await click(switchOf(titleOf('two-spaces-between-lines-with-content')));

    expect(confirmRequests).toHaveLength(1);
    const text = JSON.stringify(confirmRequests[0]);
    expect(text).toContain(titleOf('paragraph-blank-lines'));
    expect(text).toContain(titleOf('two-spaces-between-lines-with-content'));
    expect(text).not.toContain('{name}');
    expect(text).not.toContain('{names}');
  });

  it('turns the rival off and the new rule on in one write', async () => {
    setLinter({ ruleConfigs: { 'paragraph-blank-lines': { enabled: true } } });
    render();
    await ruleRowsRendered();

    await click(switchOf(titleOf('two-spaces-between-lines-with-content')));

    expect(patches).toHaveLength(1);
    const linter = patches[0].linter as LinterSettingsValue;
    expect(linter.ruleConfigs['two-spaces-between-lines-with-content']?.enabled).toBe(true);
    expect(linter.ruleConfigs['paragraph-blank-lines']?.enabled).toBe(false);
  });

  it('writes nothing when the reader declines to give the rival up', async () => {
    confirmAnswer = false;
    setLinter({ ruleConfigs: { 'paragraph-blank-lines': { enabled: true } } });
    render();
    await ruleRowsRendered();

    await click(switchOf(titleOf('two-spaces-between-lines-with-content')));

    expect(patches).toEqual([]);
  });

  it('switches a rule off without asking', async () => {
    setLinter({ ruleConfigs: { 'trailing-spaces': { enabled: true } } });
    render();
    await ruleRowsRendered();

    await click(switchOf(titleOf('trailing-spaces')));

    expect(confirmRequests).toEqual([]);
    expect(patches).toHaveLength(1);
    expect((patches[0].linter as LinterSettingsValue).ruleConfigs['trailing-spaces']?.enabled).toBe(false);
  });

  it('keeps a rule’s own options when it is switched off and on again', async () => {
    setLinter({ ruleConfigs: { 'trailing-spaces': { enabled: true, two_space_line_break: true } } });
    render();
    await ruleRowsRendered();

    await click(switchOf(titleOf('trailing-spaces')));
    await click(switchOf(titleOf('trailing-spaces')));

    const last = patches[patches.length - 1].linter as LinterSettingsValue;
    expect(last.ruleConfigs['trailing-spaces']).toMatchObject({ enabled: true, two_space_line_break: true });
  });
});

describe('the conflict question', () => {
  it('is only asked when the rival is actually on', async () => {
    setLinter({ ruleConfigs: {} });
    render();
    await ruleRowsRendered();

    await click(switchOf(titleOf('two-spaces-between-lines-with-content')));

    expect(confirmRequests).toEqual([]);
    expect((patches[0].linter as LinterSettingsValue).ruleConfigs['two-spaces-between-lines-with-content']?.enabled).toBe(true);
  });
});
