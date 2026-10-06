import { infoFlag, infoOption, infoTokens } from './info-string';

export type ExampleLayout = 'lr' | 'rl' | 'tb' | 'bt';
export type ExampleFamily = 'md' | 'js';

export interface ExampleSplitOptions {
  layout: ExampleLayout;
  ratio: [number, number];
}

export const EXAMPLE_SPLIT_DEFAULTS: Record<ExampleFamily, ExampleSplitOptions> = {
  md: { layout: 'lr', ratio: [45, 55] },
  js: { layout: 'tb', ratio: [45, 55] },
};

export const EXAMPLE_RATIO_PRESETS: ReadonlyArray<readonly [number, number]> = [
  [2, 8],
  [3, 7],
  [4, 6],
  [5, 5],
  [6, 4],
  [7, 3],
  [8, 2],
];

const LAYOUTS: Record<string, ExampleLayout> = {
  lr: 'lr',
  'left-right': 'lr',
  horizontal: 'lr',
  row: 'lr',
  rl: 'rl',
  'right-left': 'rl',
  tb: 'tb',
  'top-bottom': 'tb',
  vertical: 'tb',
  column: 'tb',
  bt: 'bt',
  'bottom-top': 'bt',
};

const MANAGED_KEYS = new Set(['layout', 'direction', 'ratio']);

export function parseExampleRatio(value: string): [number, number] | null {
  const match = /^(\d{1,3})\s*:\s*(\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first < 1 || first > 99 || second < 1 || second > 99) return null;
  return [first, second];
}

export function exampleRatioLabel(ratio: readonly [number, number]): string {
  return `${ratio[0]}:${ratio[1]}`;
}

export function isVerticalExampleLayout(layout: string): boolean {
  return layout === 'tb' || layout === 'bt';
}

export function isExampleLayout(value: string): value is ExampleLayout {
  return value === 'lr' || value === 'rl' || value === 'tb' || value === 'bt';
}

export function exampleSplitTracks(ratio: readonly [number, number]): string {
  return `${ratio[0]}fr ${ratio[1]}fr`;
}

function sameRatio(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function parseExampleSplit(info: string, defaults: ExampleSplitOptions): ExampleSplitOptions {
  const options: ExampleSplitOptions = {
    layout: defaults.layout,
    ratio: [defaults.ratio[0], defaults.ratio[1]],
  };
  for (const raw of infoTokens(info)) {
    const token = infoOption(raw);
    if (!token || !MANAGED_KEYS.has(token.key)) continue;
    if (token.key === 'ratio') {
      const ratio = parseExampleRatio(token.value);
      if (ratio) options.ratio = ratio;
      continue;
    }
    const layout = LAYOUTS[infoFlag(token.value)];
    if (layout) options.layout = layout;
  }
  return options;
}

export function formatExampleSplitInfo(
  info: string,
  next: ExampleSplitOptions,
  defaults: ExampleSplitOptions,
): string {
  const kept = infoTokens(info).filter((raw) => {
    const token = infoOption(raw);
    return !token || !MANAGED_KEYS.has(token.key);
  });
  if (next.layout !== defaults.layout) kept.push(`layout=${next.layout}`);
  if (!sameRatio(next.ratio, defaults.ratio)) kept.push(`ratio="${exampleRatioLabel(next.ratio)}"`);
  return kept.join(' ');
}
