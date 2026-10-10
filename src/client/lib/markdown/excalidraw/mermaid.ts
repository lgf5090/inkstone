export interface MermaidNode {
    id: string;
    text: string;
    shape: 'rectangle' | 'ellipse' | 'diamond';
}

export interface MermaidEdge {
    from: string;
    to: string;
    label?: string;
}

export interface MermaidParsedGraph {
    direction: 'TD' | 'LR' | 'TB';
    nodes: Map<string, MermaidNode>;
    edges: MermaidEdge[];
}

export function parseMermaidFlowchart(code: string): MermaidParsedGraph {
    const lines = code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('%%'));
    let direction: 'TD' | 'LR' | 'TB' = 'TD';
    const nodes = new Map<string, MermaidNode>();
    const edges: MermaidEdge[] = [];

    const firstLine = lines[0] ?? '';
    const dirMatch = firstLine.match(/^(?:graph|flowchart)\s+(TD|LR|TB|RL|BT)/i);
    if (dirMatch) {
        direction = dirMatch[1].toUpperCase() as any;
    }

    const parseNodeDef = (raw: string): string => {
        const trimmed = raw.trim();
        const diamondMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\{([^}]+)\}$/);
        if (diamondMatch) {
            const id = diamondMatch[1];
            nodes.set(id, { id, text: diamondMatch[2].trim(), shape: 'diamond' });
            return id;
        }

        const roundMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\(([^)]+)\)$/);
        if (roundMatch) {
            const id = roundMatch[1];
            nodes.set(id, { id, text: roundMatch[2].trim(), shape: 'ellipse' });
            return id;
        }

        const rectMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*\[([^\]]+)\]$/);
        if (rectMatch) {
            const id = rectMatch[1];
            nodes.set(id, { id, text: rectMatch[2].trim(), shape: 'rectangle' });
            return id;
        }

        const plainId = trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
        if (plainId && !nodes.has(plainId)) {
            nodes.set(plainId, { id: plainId, text: plainId, shape: 'rectangle' });
        }
        return plainId || trimmed;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('graph') || line.startsWith('flowchart')) continue;

        const arrowMatch = line.match(/^(.*?)\s*(?:-->|---|==>)\s*(?:\|([^|]+)\|\s*)?(.*)$/);
        if (arrowMatch) {
            const leftRaw = arrowMatch[1];
            const edgeLabel = arrowMatch[2]?.trim();
            const rightRaw = arrowMatch[3];

            const fromId = parseNodeDef(leftRaw);
            const toId = parseNodeDef(rightRaw);

            if (fromId && toId) {
                edges.push({
                    from: fromId,
                    to: toId,
                    label: edgeLabel,
                });
            }
        } else {
            parseNodeDef(line);
        }
    }

    return { direction, nodes, edges };
}

export function convertMermaidToExcalidrawElements(
    code: string,
    startX = 100,
    startY = 100,
): any[] {
    const graph = parseMermaidFlowchart(code);
    if (graph.nodes.size === 0) return [];

    const elements: any[] = [];
    const isHorizontal = graph.direction === 'LR';
    const nodeCoords = new Map<string, { x: number; y: number; width: number; height: number; shapeId: string; textId: string }>();

    const nodeArray = Array.from(graph.nodes.values());
    const spacingX = isHorizontal ? 240 : 180;
    const spacingY = isHorizontal ? 120 : 160;

    nodeArray.forEach((node, index) => {
        const col = isHorizontal ? index % 4 : index % 3;
        const row = Math.floor(index / (isHorizontal ? 4 : 3));

        const x = startX + col * spacingX;
        const y = startY + row * spacingY;
        const width = 140;
        const height = 64;

        const shapeId = `node_${node.id}_${Date.now()}_${index}`;
        const textId = `text_${node.id}_${Date.now()}_${index}`;

        nodeCoords.set(node.id, { x, y, width, height, shapeId, textId });

        const shapeElement = {
            id: shapeId,
            type: node.shape,
            x,
            y,
            width,
            height,
            strokeColor: '#1e1e1e',
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
            boundElements: [{ id: textId, type: 'text' }],
        };

        const textElement = {
            id: textId,
            type: 'text',
            x: x + 10,
            y: y + 20,
            width: width - 20,
            height: 24,
            text: node.text,
            originalText: node.text,
            fontSize: 16,
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

    graph.edges.forEach((edge, edgeIndex) => {
        const fromCoord = nodeCoords.get(edge.from);
        const toCoord = nodeCoords.get(edge.to);
        if (!fromCoord || !toCoord) return;

        const arrowId = `arrow_${edge.from}_${edge.to}_${Date.now()}_${edgeIndex}`;
        const startPointX = fromCoord.x + fromCoord.width / 2;
        const startPointY = fromCoord.y + fromCoord.height;
        const endPointX = toCoord.x + toCoord.width / 2;
        const endPointY = toCoord.y;

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
            strokeWidth: 2,
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
    });

    return elements;
}
