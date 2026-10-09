import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../lib/markdown/renderer';
import { enhancePreview } from '../../lib/markdown/enhance';

/**
 * A note card renders a few lines of another note and deliberately draws neither diagrams nor charts,
 * but it only runs the enhancer at all when it spots something that needs it. A chart fence becomes a
 * `div.chart-block`, which is none of `pre code` / `[data-math]` / `[data-mermaid]`, so a note whose
 * only rich content is a chart skipped the pass and the card showed "Rendering chart…" forever — a
 * loading state nothing would ever resolve.
 */
const CHART_ONLY = '```chart style=table\n| :bar: | Jan | Feb |\n| --- | --- | --- |\n| A | 12 | 19 |\n```\n';

describe('a chart block reaching a note card', () => {
  it('is not caught by any of the guard terms the card used to test for', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(CHART_ONLY).html;
    expect(host.querySelector('[data-chart]')).not.toBeNull();
    expect(host.querySelector('pre code')).toBeNull();
    expect(host.querySelector('[data-math]')).toBeNull();
    expect(host.querySelector('[data-mermaid]')).toBeNull();
    expect(host.querySelector('[data-chart]')!.classList.contains('loading')).toBe(true);
  });

  it('settles on its body as text once the card declines to draw it', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(CHART_ONLY).html;
    await enhancePreview(host, { math: false, mermaid: false, chart: false, kanban: 'source', mindmap: 'source', dataview: 'source', dark: false });
    const block = host.querySelector<HTMLElement>('[data-chart]')!;
    expect(block.classList.contains('loading')).toBe(false);
    expect(block.classList.contains('chart-source')).toBe(true);
    expect(block.textContent).toContain(':bar:');
    expect(block.textContent).not.toContain('Rendering chart');
    expect(block.querySelector('canvas')).toBeNull();
  });

  it('leaves the chart alone for a surface that does draw it, so the card is the only decliner', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(CHART_ONLY).html;
    await enhancePreview(host, { math: false, mermaid: false, chart: true, kanban: 'source', mindmap: 'source', dataview: 'source', dark: false });
    expect(host.querySelector<HTMLElement>('[data-chart]')!.classList.contains('chart-source')).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-chart]')!.classList.contains('loading')).toBe(true);
  });
});
