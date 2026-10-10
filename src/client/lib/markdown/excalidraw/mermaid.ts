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
    const isHorizontal = graph.direction === 'LR' || graph.direction === 'RL';

    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const [id] of graph.nodes) {
        inDegree.set(id, 0);
        adj.set(id, []);
    }
    for (const edge of graph.edges) {
        if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) {
            inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
            adj.get(edge.from)?.push(edge.to);
        }
    }

    const rankMap = new Map<string, number>();
    const queue: string[] = [];

    for (const [id, deg] of inDegree) {
        if (deg === 0) {
            rankMap.set(id, 0);
            queue.push(id);
        }
    }

    if (queue.length === 0) {
        const first = graph.nodes.keys().next().value;
        if (first) {
            rankMap.set(first, 0);
            queue.push(first);
        }
    }

    while (queue.length > 0) {
        const u = queue.shift()!;
        const currentRank = rankMap.get(u) || 0;
        const neighbors = adj.get(u) || [];
        for (const v of neighbors) {
            const nextRank = currentRank + 1;
            if (!rankMap.has(v) || (rankMap.get(v)! < nextRank && nextRank < 30)) {
                rankMap.set(v, nextRank);
                queue.push(v);
            }
        }
    }

    for (const [id] of graph.nodes) {
        if (!rankMap.has(id)) {
            rankMap.set(id, 0);
        }
    }

    const ranks: Map<number, string[]> = new Map();
    for (const [id, r] of rankMap) {
        if (!ranks.has(r)) ranks.set(r, []);
        ranks.get(r)!.push(id);
    }

    const nodeCoords = new Map<string, { x: number; y: number; width: number; height: number; shapeId: string; textId: string }>();
    const nodeWidth = 140;
    const nodeHeight = 64;
    const spacingX = isHorizontal ? 240 : 180;
    const spacingY = isHorizontal ? 120 : 160;

    const sortedRankKeys = Array.from(ranks.keys()).sort((a, b) => a - b);

    sortedRankKeys.forEach((r) => {
        const nodesInRank = ranks.get(r)!;
        nodesInRank.forEach((nodeId, idx) => {
            const node = graph.nodes.get(nodeId)!;
            const rankCenterOffset = ((nodesInRank.length - 1) / 2) * (isHorizontal ? spacingY : spacingX);

            let x: number;
            let y: number;

            if (isHorizontal) {
                x = startX + r * spacingX;
                y = startY + idx * spacingY - rankCenterOffset + 150;
            } else {
                x = startX + idx * spacingX - rankCenterOffset + 250;
                y = startY + r * spacingY;
            }

            const shapeId = `node_${node.id}_${Date.now()}_${idx}_${r}`;
            const textId = `text_${node.id}_${Date.now()}_${idx}_${r}`;

            nodeCoords.set(node.id, { x, y, width: nodeWidth, height: nodeHeight, shapeId, textId });

            const shapeElement = {
                id: shapeId,
                type: node.shape,
                x,
                y,
                width: nodeWidth,
                height: nodeHeight,
                strokeColor: '#1e1e1e',
                backgroundColor: node.shape === 'diamond' ? '#fef3c7' : '#e0e7ff',
                fillStyle: 'solid',
                strokeWidth: 2,
                roughness: 1,
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
                y: y + 20,
                width: nodeWidth - 20,
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
        });
    });

    graph.edges.forEach((edge, edgeIndex) => {
        const fromCoord = nodeCoords.get(edge.from);
        const toCoord = nodeCoords.get(edge.to);
        if (!fromCoord || !toCoord) return;

        const arrowId = `arrow_${edge.from}_${edge.to}_${Date.now()}_${edgeIndex}`;
        let startPointX: number;
        let startPointY: number;
        let endPointX: number;
        let endPointY: number;

        if (isHorizontal) {
            startPointX = fromCoord.x + fromCoord.width;
            startPointY = fromCoord.y + fromCoord.height / 2;
            endPointX = toCoord.x;
            endPointY = toCoord.y + toCoord.height / 2;
        } else {
            startPointX = fromCoord.x + fromCoord.width / 2;
            startPointY = fromCoord.y + fromCoord.height;
            endPointX = toCoord.x + toCoord.width / 2;
            endPointY = toCoord.y;
        }

        const arrowElement = {
            id: arrowId,
            type: 'arrow',
            x: startPointX,
            y: startPointY,
            width: Math.abs(endPointX - startPointX),
            height: Math.abs(endPointY - startPointY),
            points: [
                [0, 0],
                [endPointX - startPointX, endPointY - startPointY],
            ],
            strokeColor: '#4f46e5',
            backgroundColor: 'transparent',
            strokeWidth: edge.style === 'thick' ? 3 : 2,
            strokeStyle: edge.style === 'dashed' ? 'dashed' : 'solid',
            roughness: 1,
            startArrowhead: null,
            endArrowhead: 'arrow',
            startBinding: { elementId: fromCoord.shapeId, focus: 0, gap: 4 },
            endBinding: { elementId: toCoord.shapeId, focus: 0, gap: 4 },
            seed: Math.floor(Math.random() * 100000),
            version: 1,
            versionNonce: 1,
            isDeleted: false,
        };

        elements.push(arrowElement);

        if (edge.label) {
            const midX = (startPointX + endPointX) / 2 - 25;
            const midY = (startPointY + endPointY) / 2 - 14;
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
