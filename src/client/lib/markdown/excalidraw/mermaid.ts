import { layout } from 'dagre-d3-es/src/dagre/index.js';
import { Graph } from 'dagre-d3-es/src/graphlib/index.js';

export interface MermaidNode {
    id: string;
    text: string;
    shape: 'rectangle' | 'ellipse' | 'diamond';
}

export interface MermaidEdge {
    from: string;
    to: string;
    label?: string;
    style?: 'solid' | 'dashed' | 'thick';
}

export interface MermaidParsedGraph {
    direction: 'TD' | 'LR' | 'TB' | 'RL' | 'BT';
    nodes: Map<string, MermaidNode>;
    edges: MermaidEdge[];
}

export interface SequenceMessage {
    from: string;
    to: string;
    label: string;
    isDashed: boolean;
}

export interface SequenceDiagramData {
    participants: Array<{ id: string; label: string }>;
    messages: SequenceMessage[];
}

function cleanQuotes(str: string): string {
    return str.replace(/^["'`]|["'`]$/g, '').trim();
}

function parseNodeShape(raw: string, nodes: Map<string, MermaidNode>): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';

    const stadiumMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\(\[\s*(.*?)\s*\]\)$/);
    if (stadiumMatch) {
        const id = stadiumMatch[1];
        const text = cleanQuotes(stadiumMatch[2]) || id;
        nodes.set(id, { id, text, shape: 'ellipse' });
        return id;
    }

    const dbMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\[\(\s*(.*?)\s*\)\]$/);
    if (dbMatch) {
        const id = dbMatch[1];
        const text = cleanQuotes(dbMatch[2]) || id;
        nodes.set(id, { id, text, shape: 'rectangle' });
        return id;
    }

    const circleMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\(\(\s*(.*?)\s*\)\)$/);
    if (circleMatch) {
        const id = circleMatch[1];
        const text = cleanQuotes(circleMatch[2]) || id;
        nodes.set(id, { id, text, shape: 'ellipse' });
        return id;
    }

    const subMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\[\[\s*(.*?)\s*\]\]$/);
    if (subMatch) {
        const id = subMatch[1];
        const text = cleanQuotes(subMatch[2]) || id;
        nodes.set(id, { id, text, shape: 'rectangle' });
        return id;
    }

    const diamondMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\{\{?\s*(.*?)\s*\}\}?$/);
    if (diamondMatch) {
        const id = diamondMatch[1];
        const text = cleanQuotes(diamondMatch[2]) || id;
        nodes.set(id, { id, text, shape: 'diamond' });
        return id;
    }

    const roundMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\(\s*(.*?)\s*\)$/);
    if (roundMatch) {
        const id = roundMatch[1];
        const text = cleanQuotes(roundMatch[2]) || id;
        nodes.set(id, { id, text, shape: 'ellipse' });
        return id;
    }

    const rectMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\[\s*(.*?)\s*\]$/);
    if (rectMatch) {
        const id = rectMatch[1];
        const text = cleanQuotes(rectMatch[2]) || id;
        nodes.set(id, { id, text, shape: 'rectangle' });
        return id;
    }

    const plainId = trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
    if (plainId && !nodes.has(plainId)) {
        nodes.set(plainId, { id: plainId, text: plainId, shape: 'rectangle' });
    }
    return plainId || trimmed;
}

export function parseMermaidFlowchart(code: string): MermaidParsedGraph {
    const rawLines = code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('%%'));
    let direction: 'TD' | 'LR' | 'TB' = 'TD';
    const nodes = new Map<string, MermaidNode>();
    const edges: MermaidEdge[] = [];

    const firstLine = rawLines[0] ?? '';
    const dirMatch = firstLine.match(/^(?:graph|flowchart)\s+(TD|LR|TB|RL|BT)/i);
    if (dirMatch) {
        direction = dirMatch[1].toUpperCase() as any;
    }

    const lines = rawLines.filter((l) => {
        if (/^(?:graph|flowchart)\b/i.test(l)) return false;
        if (/^subgraph\b/i.test(l)) return false;
        if (/^end\b/i.test(l)) return false;
        if (/^(?:classDef|class|style|linkStyle|click|accTitle|accDescr)\b/i.test(l)) return false;
        return true;
    });

    const arrowRegex = /\s*(?:(-->|---|==>|-\.->)\s*(?:\|([^|]+)\|)?|--\s*([^-]+?)\s*-->|-\.\s*([^-]+?)\s*\.->|==\s*([^=]+?)\s*==>)\s*/g;

    for (const line of lines) {
        arrowRegex.lastIndex = 0;
        const matches: Array<{ index: number; length: number; arrowType: string; label?: string }> = [];
        let m: RegExpExecArray | null;

        while ((m = arrowRegex.exec(line)) !== null) {
            const arrowType = m[1] || '-->';
            const label = m[2] || m[3] || m[4] || m[5] || undefined;
            matches.push({
                index: m.index,
                length: m[0].length,
                arrowType,
                label: label?.trim(),
            });
        }

        if (matches.length > 0) {
            const rawNodeSegments: string[] = [];
            let lastIndex = 0;
            for (const match of matches) {
                rawNodeSegments.push(line.slice(lastIndex, match.index).trim());
                lastIndex = match.index + match.length;
            }
            rawNodeSegments.push(line.slice(lastIndex).trim());

            const parsedNodeIds = rawNodeSegments.map((seg) => parseNodeShape(seg, nodes)).filter(Boolean);

            for (let i = 0; i < matches.length; i++) {
                const fromId = parsedNodeIds[i];
                const toId = parsedNodeIds[i + 1];
                if (fromId && toId) {
                    const style = matches[i].arrowType === '-.->'
                        ? 'dashed'
                        : matches[i].arrowType === '==>'
                            ? 'thick'
                            : 'solid';
                    edges.push({
                        from: fromId,
                        to: toId,
                        label: matches[i].label,
                        style,
                    });
                }
            }
        } else {
            parseNodeShape(line, nodes);
        }
    }

    return { direction, nodes, edges };
}

export function parseSequenceDiagram(code: string): SequenceDiagramData {
    const lines = code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('%%'));
    const participantsMap = new Map<string, string>();
    const messages: SequenceMessage[] = [];

    for (const line of lines) {
        if (/^sequenceDiagram\b/i.test(line)) continue;
        if (/^autonumber\b/i.test(line)) continue;

        const partMatch = line.match(/^(?:participant|actor)\s+([a-zA-Z0-9_]+)(?:\s+as\s+(.+))?$/i);
        if (partMatch) {
            const id = partMatch[1];
            const label = cleanQuotes(partMatch[2] || id);
            participantsMap.set(id, label);
            continue;
        }

        const msgMatch = line.match(/^([a-zA-Z0-9_]+)\s*(-->>|->>|-->|->|-x)\s*([a-zA-Z0-9_]+)\s*:\s*(.+)$/);
        if (msgMatch) {
            const from = msgMatch[1];
            const arrow = msgMatch[2];
            const to = msgMatch[3];
            const label = cleanQuotes(msgMatch[4]);
            if (!participantsMap.has(from)) participantsMap.set(from, from);
            if (!participantsMap.has(to)) participantsMap.set(to, to);
            messages.push({
                from,
                to,
                label,
                isDashed: arrow.includes('--'),
            });
        }
    }

    const participants = Array.from(participantsMap.entries()).map(([id, label]) => ({ id, label }));
    return { participants, messages };
}

export function convertSequenceDiagramToExcalidraw(
    data: SequenceDiagramData,
    startX = 100,
    startY = 100,
): any[] {
    if (data.participants.length === 0) return [];
    const elements: any[] = [];
    const spacingX = 220;
    const participantW = 120;
    const participantH = 44;
    const headerOffset = 70;
    const msgStep = 60;
    const totalHeight = headerOffset + Math.max(data.messages.length * msgStep, 80) + 70;

    const coords = new Map<string, number>();

    data.participants.forEach((p, idx) => {
        const x = startX + idx * spacingX;
        coords.set(p.id, x);

        const topBoxId = `seq_p_top_${p.id}_${Date.now()}_${idx}`;
        const topTextId = `seq_p_top_txt_${p.id}_${Date.now()}_${idx}`;

        elements.push(
            {
                id: topBoxId,
                type: 'rectangle',
                x: x - participantW / 2,
                y: startY,
                width: participantW,
                height: participantH,
                strokeColor: '#4338ca',
                backgroundColor: '#e0e7ff',
                fillStyle: 'solid',
                strokeWidth: 2,
                roughness: 1,
                opacity: 100,
                roundness: { type: 3 },
                seed: Math.floor(Math.random() * 100000),
                version: 1,
                versionNonce: 1,
                isDeleted: false,
                boundElements: [{ id: topTextId, type: 'text' }],
            },
            {
                id: topTextId,
                type: 'text',
                x: x - participantW / 2 + 8,
                y: startY + 12,
                width: participantW - 16,
                height: 20,
                text: p.label,
                originalText: p.label,
                fontSize: 14,
                fontFamily: 1,
                lineHeight: 1.25,
                textAlign: 'center',
                verticalAlign: 'middle',
                containerId: topBoxId,
                strokeColor: '#1e1e1e',
                backgroundColor: 'transparent',
                seed: Math.floor(Math.random() * 100000),
                version: 1,
                versionNonce: 1,
                isDeleted: false,
            },
        );

        elements.push({
            id: `seq_line_${p.id}_${Date.now()}_${idx}`,
            type: 'line',
            x,
            y: startY + participantH,
            width: 0,
            height: totalHeight - participantH * 2,
            points: [
                [0, 0],
                [0, totalHeight - participantH * 2],
            ],
            strokeColor: '#94a3b8',
            backgroundColor: 'transparent',
            strokeWidth: 1.5,
            strokeStyle: 'dashed',
            roughness: 0,
            seed: Math.floor(Math.random() * 100000),
            version: 1,
            versionNonce: 1,
            isDeleted: false,
        });

        const botBoxId = `seq_p_bot_${p.id}_${Date.now()}_${idx}`;
        const botTextId = `seq_p_bot_txt_${p.id}_${Date.now()}_${idx}`;

        elements.push(
            {
                id: botBoxId,
                type: 'rectangle',
                x: x - participantW / 2,
                y: startY + totalHeight - participantH,
                width: participantW,
                height: participantH,
                strokeColor: '#4338ca',
                backgroundColor: '#e0e7ff',
                fillStyle: 'solid',
                strokeWidth: 2,
                roughness: 1,
                opacity: 100,
                roundness: { type: 3 },
                seed: Math.floor(Math.random() * 100000),
                version: 1,
                versionNonce: 1,
                isDeleted: false,
                boundElements: [{ id: botTextId, type: 'text' }],
            },
            {
                id: botTextId,
                type: 'text',
                x: x - participantW / 2 + 8,
                y: startY + totalHeight - participantH + 12,
                width: participantW - 16,
                height: 20,
                text: p.label,
                originalText: p.label,
                fontSize: 14,
                fontFamily: 1,
                lineHeight: 1.25,
                textAlign: 'center',
                verticalAlign: 'middle',
                containerId: botBoxId,
                strokeColor: '#1e1e1e',
                backgroundColor: 'transparent',
                seed: Math.floor(Math.random() * 100000),
                version: 1,
                versionNonce: 1,
                isDeleted: false,
            },
        );
    });

    data.messages.forEach((msg, idx) => {
        const fromX = coords.get(msg.from) ?? startX;
        const toX = coords.get(msg.to) ?? startX;
        const y = startY + headerOffset + idx * msgStep;

        const arrowId = `seq_msg_arrow_${idx}_${Date.now()}`;
        const textId = `seq_msg_txt_${idx}_${Date.now()}`;

        elements.push({
            id: arrowId,
            type: 'arrow',
            x: fromX,
            y,
            width: Math.abs(toX - fromX),
            height: 0,
            points: [
                [0, 0],
                [toX - fromX, 0],
            ],
            strokeColor: '#4f46e5',
            backgroundColor: 'transparent',
            strokeWidth: 1.5,
            strokeStyle: msg.isDashed ? 'dashed' : 'solid',
            roughness: 1,
            startArrowhead: null,
            endArrowhead: 'arrow',
            seed: Math.floor(Math.random() * 100000),
            version: 1,
            versionNonce: 1,
            isDeleted: false,
        });

        const labelX = Math.min(fromX, toX) + Math.abs(toX - fromX) / 2 - 50;
        elements.push({
            id: textId,
            type: 'text',
            x: labelX,
            y: y - 18,
            width: 100,
            height: 16,
            text: msg.label,
            originalText: msg.label,
            fontSize: 12,
            fontFamily: 1,
            lineHeight: 1.25,
            textAlign: 'center',
            verticalAlign: 'bottom',
            strokeColor: '#334155',
            backgroundColor: 'transparent',
            seed: Math.floor(Math.random() * 100000),
            version: 1,
            versionNonce: 1,
            isDeleted: false,
        });
    });

    return elements;
}

function simplifyColinearPoints(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
    if (pts.length <= 2) return pts;
    const result: Array<{ x: number; y: number }> = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
        const prev = result[result.length - 1];
        const curr = pts[i];
        const next = pts[i + 1];
        const isColinearH = Math.abs(prev.y - curr.y) < 1 && Math.abs(curr.y - next.y) < 1;
        const isColinearV = Math.abs(prev.x - curr.x) < 1 && Math.abs(curr.x - next.x) < 1;
        if (!isColinearH && !isColinearV) {
            result.push(curr);
        }
    }
    result.push(pts[pts.length - 1]);
    return result;
}

export function convertMermaidToExcalidrawElements(
    code: string,
    startX = 100,
    startY = 100,
): any[] {
    const trimmed = code.trim();
    if (!trimmed) return [];

    if (/^\s*sequenceDiagram\b/i.test(trimmed)) {
        const seqData = parseSequenceDiagram(trimmed);
        return convertSequenceDiagramToExcalidraw(seqData, startX, startY);
    }

    const graph = parseMermaidFlowchart(trimmed);
    if (graph.nodes.size === 0) return [];

    const elements: any[] = [];
    const g = new Graph();
    const rankdir = (graph.direction === 'LR' || graph.direction === 'RL') ? graph.direction : (graph.direction === 'BT' ? 'BT' : 'TB');
    const isHorizontal = rankdir === 'LR' || rankdir === 'RL';

    g.setGraph({
        rankdir,
        nodesep: isHorizontal ? 60 : 70,
        ranksep: isHorizontal ? 90 : 80,
        marginx: 40,
        marginy: 40,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const [id, node] of graph.nodes) {
        const textLen = (node.text || node.id).length;
        const width = Math.max(140, Math.min(260, textLen * 12 + 36));
        const height = 64;
        g.setNode(id, { width, height });
    }

    for (const edge of graph.edges) {
        if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) {
            g.setEdge(edge.from, edge.to);
        }
    }

    layout(g);

    const nodeCoords = new Map<string, {
        x: number;
        y: number;
        width: number;
        height: number;
        centerX: number;
        centerY: number;
        shapeId: string;
        textId: string;
    }>();

    let nodeIndex = 0;
    for (const [id, node] of graph.nodes) {
        const n = g.node(id) || { x: 100, y: 100, width: 140, height: 64 };
        const x = Math.round(startX + n.x - n.width / 2);
        const y = Math.round(startY + n.y - n.height / 2);
        const shapeId = `node_${id}_${Date.now()}_${nodeIndex}`;
        const textId = `text_${id}_${Date.now()}_${nodeIndex}`;
        nodeIndex++;

        nodeCoords.set(id, {
            x,
            y,
            width: n.width,
            height: n.height,
            centerX: Math.round(startX + n.x),
            centerY: Math.round(startY + n.y),
            shapeId,
            textId,
        });

        const shapeElement = {
            id: shapeId,
            type: node.shape,
            x,
            y,
            width: n.width,
            height: n.height,
            strokeColor: '#1e1e1e',
            backgroundColor: node.shape === 'diamond' ? '#fef3c7' : '#e0e7ff',
            fillStyle: 'solid',
            strokeWidth: 2,
            roughness: 0,
            opacity: 100,
            roundness: { type: 3 },
            seed: Math.floor(Math.random() * 100000),
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: [{ id: textId, type: 'text' }],
        };

        const textElement = {
            id: textId,
            type: 'text',
            x: x + 10,
            y: y + Math.round((n.height - 24) / 2),
            width: n.width - 20,
            height: 24,
            text: node.text,
            originalText: node.text,
            fontSize: 15,
            fontFamily: 1,
            lineHeight: 1.25,
            textAlign: 'center',
            verticalAlign: 'middle',
            containerId: shapeId,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            seed: Math.floor(Math.random() * 100000),
            version: 1,
            versionNonce: 1,
            isDeleted: false,
        };

        elements.push(shapeElement, textElement);
    }

    graph.edges.forEach((edge, edgeIndex) => {
        const fromCoord = nodeCoords.get(edge.from);
        const toCoord = nodeCoords.get(edge.to);
        if (!fromCoord || !toCoord) return;

        const layoutEdge = g.edge(edge.from, edge.to);
        const rawPoints = layoutEdge?.points && layoutEdge.points.length >= 2
            ? layoutEdge.points
            : [
                {
                    x: fromCoord.centerX - startX,
                    y: isHorizontal ? fromCoord.centerY - startY : fromCoord.y + fromCoord.height - startY,
                },
                {
                    x: toCoord.centerX - startX,
                    y: isHorizontal ? toCoord.centerY - startY : toCoord.y - startY,
                },
            ];

        const simplified = simplifyColinearPoints(rawPoints);
        const startPt = simplified[0];
        const lastPt = simplified[simplified.length - 1];

        const arrowX = Math.round(startX + startPt.x);
        const arrowY = Math.round(startY + startPt.y);

        const relPoints: Array<[number, number]> = simplified.map((p) => [
            Math.round(p.x - startPt.x),
            Math.round(p.y - startPt.y),
        ]);

        const absXList = simplified.map((p) => p.x);
        const absYList = simplified.map((p) => p.y);
        const minX = Math.min(...absXList);
        const maxX = Math.max(...absXList);
        const minY = Math.min(...absYList);
        const maxY = Math.max(...absYList);
        const arrowWidth = Math.max(Math.round(maxX - minX), 1);
        const arrowHeight = Math.max(Math.round(maxY - minY), 1);

        const endFocus = isHorizontal
            ? Math.max(-0.8, Math.min(0.8, (lastPt.y + startY - toCoord.centerY) / (toCoord.height / 2 || 1)))
            : Math.max(-0.8, Math.min(0.8, (lastPt.x + startX - toCoord.centerX) / (toCoord.width / 2 || 1)));

        const arrowId = `arrow_${edge.from}_${edge.to}_${Date.now()}_${edgeIndex}`;
        const arrowElement = {
            id: arrowId,
            type: 'arrow',
            x: arrowX,
            y: arrowY,
            width: arrowWidth,
            height: arrowHeight,
            points: relPoints,
            strokeColor: '#4f46e5',
            backgroundColor: 'transparent',
            strokeWidth: edge.style === 'thick' ? 2 : 1.5,
            strokeStyle: edge.style === 'dashed' ? 'dashed' : 'solid',
            roughness: 0,
            roundness: { type: 2 },
            startArrowhead: null,
            endArrowhead: 'arrow',
            startBinding: { elementId: fromCoord.shapeId, focus: 0, gap: 4 },
            endBinding: { elementId: toCoord.shapeId, focus: Number(endFocus.toFixed(2)), gap: 4 },
            seed: Math.floor(Math.random() * 100000),
            version: 1,
            versionNonce: 1,
            isDeleted: false,
        };

        elements.push(arrowElement);

        if (edge.label) {
            const midIndex = Math.floor(simplified.length / 2);
            const midPt = simplified[midIndex] || simplified[0];
            const midX = Math.round(startX + midPt.x - 25);
            const midY = Math.round(startY + midPt.y - 12);
            elements.push({
                id: `arrow_lbl_${edgeIndex}_${Date.now()}`,
                type: 'text',
                x: midX,
                y: midY,
                width: 50,
                height: 16,
                text: edge.label,
                originalText: edge.label,
                fontSize: 12,
                fontFamily: 1,
                lineHeight: 1.25,
                textAlign: 'center',
                verticalAlign: 'middle',
                strokeColor: '#6366f1',
                backgroundColor: 'transparent',
                seed: Math.floor(Math.random() * 100000),
                version: 1,
                versionNonce: 1,
                isDeleted: false,
            });
        }
    });

    return elements;
}

