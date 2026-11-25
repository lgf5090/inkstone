import { describe, expect, it } from 'vitest';
import {
    convertMermaidToExcalidrawElements,
    parseMermaidFlowchart,
    parseSequenceDiagram,
} from './mermaid';
import { EXCALIDRAW_SCENE_PALETTE } from './scene-palette';

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

    it('keeps the serialized flowchart colours literal and unchanged', () => {
        expect(EXCALIDRAW_SCENE_PALETTE).toEqual({
            background: '#ffffff',
            foreground: '#1e1e1e',
            nodeFill: '#e0e7ff',
            nodeStroke: '#4338ca',
            decisionFill: '#fef3c7',
            connector: '#4f46e5',
            connectorLabel: '#6366f1',
            lifeline: '#94a3b8',
            sequenceLabel: '#334155',
            highlight: 'rgba(0,118,255,1)',
            transparent: 'transparent',
        })
        const elements = convertMermaidToExcalidrawElements(
            'flowchart TD\n  A[Start] --> B{Done?}\n  B -->|Yes| C[End]',
            100,
            100,
        )
        const byId = (id: string) => elements.find((element) => element.id.startsWith(id))!
        expect(byId('node_A_')).toMatchObject({
            strokeColor: '#1e1e1e',
            backgroundColor: '#e0e7ff',
        })
        expect(byId('node_B_')).toMatchObject({
            strokeColor: '#1e1e1e',
            backgroundColor: '#fef3c7',
        })
        expect(byId('arrow_A_B_').strokeColor).toBe('#4f46e5')
        expect(byId('arrow_lbl_').strokeColor).toBe('#6366f1')
        expect(JSON.stringify(elements)).not.toContain('var(')
    })

    it('handles empty or comment-only mermaid code gracefully', () => {
        const code = '%% comment only\n';
        const elements = convertMermaidToExcalidrawElements(code);
        expect(elements).toEqual([]);
    });

    it('handles chained arrows without creating phantom nodes', () => {
        const code = `
flowchart TD
    A[Start] --> B(Middle) --> C[End]
`;
        const graph = parseMermaidFlowchart(code);
        expect(graph.nodes.size).toBe(3);
        expect(graph.edges.length).toBe(2);
        expect(graph.edges[0].from).toBe('A');
        expect(graph.edges[0].to).toBe('B');
        expect(graph.edges[1].from).toBe('B');
        expect(graph.edges[1].to).toBe('C');
    });

    it('filters out subgraphs, classes, and styles without creating phantom nodes', () => {
        const code = `
graph TD
    subgraph Cluster1
        A[Step 1] --> B[Step 2]
    end
    classDef default fill:#f9f
    style A stroke:#333
`;
        const graph = parseMermaidFlowchart(code);
        expect(graph.nodes.size).toBe(2);
        expect(graph.nodes.has('subgraph')).toBe(false);
        expect(graph.nodes.has('end')).toBe(false);
        expect(graph.nodes.has('classDef')).toBe(false);
    });

    it('parses sequence diagrams correctly into participants, lifelines, and messages', () => {
        const code = `
sequenceDiagram
    participant Alice as Alice User
    participant Bob as Bob Service
    Alice->>Bob: Hello Bob!
    Bob-->>Alice: Hi Alice!
`;
        const seq = parseSequenceDiagram(code);
        expect(seq.participants.length).toBe(2);
        expect(seq.participants[0].label).toBe('Alice User');
        expect(seq.messages.length).toBe(2);
        expect(seq.messages[0].label).toBe('Hello Bob!');
        expect(seq.messages[1].isDashed).toBe(true);

        const elements = convertMermaidToExcalidrawElements(code, 100, 100);
        expect(elements.length).toBeGreaterThan(6);
        const lines = elements.filter((el) => el.type === 'line');
        const arrows = elements.filter((el) => el.type === 'arrow');
        expect(lines.length).toBe(2);
        expect(arrows.length).toBe(2);
        expect(lines.every((line) => line.strokeColor === '#94a3b8')).toBe(true);
        expect(arrows.every((arrow) => arrow.strokeColor === '#4f46e5')).toBe(true);
        const boxes = elements.filter((element) => element.type === 'rectangle');
        expect(boxes.every((box) => box.strokeColor === '#4338ca' && box.backgroundColor === '#e0e7ff')).toBe(true);
        expect(elements.filter((element) => element.type === 'text').every((text) =>
            text.strokeColor === '#1e1e1e' || text.strokeColor === '#334155')).toBe(true);
    });
});
