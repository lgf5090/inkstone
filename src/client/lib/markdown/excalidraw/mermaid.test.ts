import { describe, expect, it } from 'vitest';
import {
    convertMermaidToExcalidrawElements,
    parseMermaidFlowchart,
} from './mermaid';

describe('mermaid flowchart to excalidraw conversion', () => {
    it('parses nodes and edges from mermaid flowchart text', () => {
        const code = `
graph TD
    A[Start Node] --> B(Work Node)
    B --> C{Condition}
    C -->|Yes| D[Success]
`;
        const graph = parseMermaidFlowchart(code);
        expect(graph.direction).toBe('TD');
        expect(graph.nodes.size).toBe(4);
        expect(graph.nodes.get('A')?.text).toBe('Start Node');
        expect(graph.nodes.get('A')?.shape).toBe('rectangle');
        expect(graph.nodes.get('B')?.shape).toBe('ellipse');
        expect(graph.nodes.get('C')?.shape).toBe('diamond');
        expect(graph.edges.length).toBe(3);
        expect(graph.edges[2].label).toBe('Yes');
    });

    it('generates valid excalidraw elements with bound text and arrows', () => {
        const code = `
flowchart LR
    Alpha[First] --> Beta[Second]
`;
        const elements = convertMermaidToExcalidrawElements(code, 100, 100);
        expect(elements.length).toBeGreaterThanOrEqual(4);

        const rects = elements.filter((el) => el.type === 'rectangle');
        const texts = elements.filter((el) => el.type === 'text');
        const arrows = elements.filter((el) => el.type === 'arrow');

        expect(rects.length).toBe(2);
        expect(texts.length).toBe(2);
        expect(arrows.length).toBe(1);

        expect(arrows[0].endArrowhead).toBe('arrow');
        expect(arrows[0].points.length).toBe(2);
    });

    it('handles empty or comment-only mermaid code gracefully', () => {
        const code = '%% comment only\n';
        const elements = convertMermaidToExcalidrawElements(code);
        expect(elements).toEqual([]);
    });
});
