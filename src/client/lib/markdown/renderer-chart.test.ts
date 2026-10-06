import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './renderer';
import { decodeDataValue } from './data-attr';
import { t } from '../i18n';

function chartBlock(source: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(source).html;
    const block = host.querySelector<HTMLElement>('[data-chart]');
    if (!block)
        throw new Error(`no chart block in: ${host.innerHTML}`);
    return block;
}

/** markdown-it hands a fence body with its closing newline attached, so the attribute carries it too. */
function bodyOf(block: HTMLElement): string {
    return decodeDataValue(block.dataset.chart).replace(/\n$/, '');
}

describe('a chart fence in the rendered document', () => {
    it('draws a loading block that carries its own body', () => {
        const block = chartBlock('```chart\n{"type":"bar"}\n```\n');
        expect(block.classList.contains('chart-block')).toBe(true);
        expect(block.classList.contains('loading')).toBe(true);
        expect(block.getAttribute('aria-busy')).toBe('true');
        expect(bodyOf(block)).toBe('{"type":"bar"}');
        expect(block.textContent).toBe(t('markdown.rendering_chart'));
    });

    it('takes the chartjs alias and the line the fence sits on', () => {
        expect(bodyOf(chartBlock('```chartjs\n{"type":"pie"}\n```\n'))).toBe('{"type":"pie"}');
        expect(chartBlock('intro\n\n```chart\n{"type":"pie"}\n```\n').dataset.line).toBe('2');
    });

    it('states the format the note put on the fence, and only that', () => {
        expect(chartBlock('```chart style=table\n| :bar: | a |\n| --- | --- |\n| r | 1 |\n```\n').dataset.chartStyle).toBe('table');
        expect(chartBlock('```chartjs style="json"\n{"type":"bar"}\n```\n').dataset.chartStyle).toBe('json');
        expect(chartBlock('```chart\n{"type":"bar"}\n```\n').hasAttribute('data-chart-style')).toBe(false);
    });

    it('keeps a title beside the format without swallowing either', () => {
        const block = chartBlock('```chart title="Tally" style=table\n| :bar: | a |\n| --- | --- |\n| r | 1 |\n```\n');
        expect(block.dataset.chartStyle).toBe('table');
        expect(decodeDataValue(block.dataset.chart)).toContain(':bar:');
    });

    it('holds a hostile body inside the attribute rather than in the markup', () => {
        const hostile = '```chart\n"><img src=x onerror="alert(1)"><script>alert(2)<\/script>\n```\n';
        const block = chartBlock(hostile);
        expect(block.querySelector('img, script, iframe')).toBeNull();
        expect(bodyOf(block)).toContain('onerror');
    });

    it('survives a table body whose cells carry pipes and braces', () => {
        const source = '```chart style=table\n| :bar:{"title": "T"} | a | b |\n| --- | --- | --- |\n| r \\| s | 1 | 2 |\n```\n';
        expect(bodyOf(chartBlock(source))).toContain('| :bar:{"title": "T"} | a | b |');
    });

    it('does not turn an ordinary code fence into a chart', () => {
        const host = document.createElement('div');
        host.innerHTML = renderMarkdown('```js\nconst a = 1\n```\n\n```mermaid\ngraph TD;A-->B;\n```\n').html;
        expect(host.querySelector('[data-chart]')).toBeNull();
        expect(host.querySelector('[data-mermaid]')).not.toBeNull();
    });
});
