import katex from 'katex';
import katexPrintCss from 'katex/dist/katex.min.css?inline';
import { prompt } from '../../components/overlay';
import { t } from '../../lib/i18n';
import { escapeHtml } from '../../lib/markdown/data-attr';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';
import { applySceneElements } from '../../lib/markdown/excalidraw/loader';

export interface BoundingBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
}

export function computeElementsBounds(elements: any[]): BoundingBox | null {
    const validElements = elements.filter((el) => !el.isDeleted);
    if (validElements.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const el of validElements) {
        const x = Number(el.x) || 0;
        const y = Number(el.y) || 0;
        const w = Number(el.width) || 0;
        const h = Number(el.height) || 0;

        if (Array.isArray(el.points) && el.points.length > 0) {
            for (const pt of el.points) {
                const px = x + (Number(pt[0]) || 0);
                const py = y + (Number(pt[1]) || 0);
                minX = Math.min(minX, px);
                minY = Math.min(minY, py);
                maxX = Math.max(maxX, px);
                maxY = Math.max(maxY, py);
            }
        } else if (el.angle && el.angle !== 0) {
            const cx = x + w / 2;
            const cy = y + h / 2;
            const cos = Math.abs(Math.cos(el.angle));
            const sin = Math.abs(Math.sin(el.angle));
            const halfW = (Math.abs(w) / 2) * cos + (Math.abs(h) / 2) * sin;
            const halfH = (Math.abs(w) / 2) * sin + (Math.abs(h) / 2) * cos;
            minX = Math.min(minX, cx - halfW);
            minY = Math.min(minY, cy - halfH);
            maxX = Math.max(maxX, cx + halfW);
            maxY = Math.max(maxY, cy + halfH);
        } else {
            minX = Math.min(minX, x, x + w);
            minY = Math.min(minY, y, y + h);
            maxX = Math.max(maxX, x, x + w);
            maxY = Math.max(maxY, y, y + h);
        }
    }

    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;

    const width = Math.max(maxX - minX, 10);
    const height = Math.max(maxY - minY, 10);
    const centerX = minX + width / 2;
    const centerY = minY + height / 2;

    return { minX, minY, maxX, maxY, width, height, centerX, centerY };
}

export function zoomToFitScene(api: any, container?: HTMLElement | null): void {
    if (!api) return;
    const rawElements = (typeof api.getSceneElements === 'function' ? api.getSceneElements() : []) as any[];
    const elements = rawElements.filter((el: any) => !el.isDeleted);
    if (!elements || elements.length === 0) return;

    const bounds = computeElementsBounds(elements);
    if (!bounds) return;

    const appState = (typeof api.getAppState === 'function' ? api.getAppState() : {}) as any;
    const viewportWidth = (appState.width && appState.width > 0)
        ? appState.width
        : (container && container.clientWidth > 0 ? container.clientWidth : (typeof window !== 'undefined' ? window.innerWidth : 800));
    const viewportHeight = (appState.height && appState.height > 0)
        ? appState.height
        : (container && container.clientHeight > 0 ? container.clientHeight : (typeof window !== 'undefined' ? window.innerHeight : 600));

    const zoomX = (viewportWidth * 0.85) / bounds.width;
    const zoomY = (viewportHeight * 0.85) / bounds.height;
    let nextZoom = Math.min(zoomX, zoomY);
    nextZoom = Math.max(0.1, Math.min(nextZoom, 2));
    nextZoom = Math.round(nextZoom * 100) / 100;

    const scrollX = (viewportWidth / 2) / nextZoom - bounds.centerX;
    const scrollY = (viewportHeight / 2) / nextZoom - bounds.centerY;

    if (typeof api.scrollToContent === 'function') {
        try {
            api.scrollToContent(elements, {
                fitToViewport: true,
                viewportZoomFactor: 0.85,
                animate: true,
            });
        } catch {
        }
    } else if (typeof api.zoomToFit === 'function') {
        try {
            api.zoomToFit(elements, 2, 0.15);
        } catch {
        }
    }

    if (typeof api.updateScene === 'function') {
        api.updateScene({
            appState: {
                zoom: { value: nextZoom },
                scrollX,
                scrollY,
            },
        });
    }
}

export function getViewportCenterInScene(api: any): { x: number; y: number } {
    const appState = (typeof api?.getAppState === 'function' ? api.getAppState() : {}) as any;
    const zoom = appState.zoom?.value || 1;
    const viewportW = appState.width || 800;
    const viewportH = appState.height || 600;
    const scrollX = appState.scrollX || 0;
    const scrollY = appState.scrollY || 0;

    const x = (viewportW / 2) / zoom - scrollX;
    const y = (viewportH / 2) / zoom - scrollY;
    return { x, y };
}

export function createLatexSvg(latex: string, dark = false): { dataURL: string; width: number; height: number } {
    const textColor = dark ? '#f1f5f9' : '#0f172a';
    let html = '';
    try {
        html = katex.renderToString(latex, { displayMode: true, throwOnError: false });
    } catch {
        html = `<span class="katex">${escapeHtml(latex)}</span>`;
    }

    const settings = useExcalidrawSettingsStore.getState();
    const fontSize = settings.latexFontSize || 24;

    let width = 240;
    let height = 80;

    if (typeof document !== 'undefined') {
        const temp = document.createElement('div');
        temp.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:-9999px;font-size:${fontSize}px;display:inline-block;padding:12px;line-height:1.2;`;
        temp.innerHTML = html;
        document.body.appendChild(temp);
        const rect = temp.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            width = Math.ceil(rect.width) + 24;
            height = Math.ceil(rect.height) + 24;
        }
        document.body.removeChild(temp);
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    ${katexPrintCss}
    .katex-display { margin: 0; }
    .katex { color: ${textColor}; font-size: ${fontSize}px; }
  </style>
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:${textColor};font-size:${fontSize}px;">
      ${html}
    </div>
  </foreignObject>
</svg>`;

    return {
        dataURL: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        width,
        height,
    };
}

export function insertLatexToCanvas(api: any, latex: string, dark = false): void {
    if (!api || !latex.trim()) return;
    const { dataURL, width, height } = createLatexSvg(latex.trim(), dark);
    const fileId = `latex_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    if (typeof api.addFiles === 'function') {
        api.addFiles([
            {
                id: fileId,
                dataURL,
                mimeType: 'image/svg+xml',
                created: Date.now(),
            },
        ]);
    }

    const center = getViewportCenterInScene(api);
    const imageEl = {
        id: `el_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'image',
        x: Math.round(center.x - width / 2),
        y: Math.round(center.y - height / 2),
        width,
        height,
        fileId,
        status: 'saved',
        scale: [1, 1],
        crop: null,
        customData: { latex: latex.trim() },
        strokeColor: 'transparent',
        backgroundColor: 'transparent',
    };

    const current = typeof api.getSceneElements === 'function' ? api.getSceneElements() : [];
    applySceneElements(api, [...current, imageEl]);
}

export async function promptAndInsertLatex(api: any, dark = false): Promise<void> {
    const toast = useUi.getState().toast;
    const settings = useExcalidrawSettingsStore.getState();
    const latex = await prompt({
        title: t('excalidraw.insert_latex_prompt') || 'Enter LaTeX formula:',
        placeholder: settings.latexBoilerplate || '\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}',
    });
    if (latex && latex.trim()) {
        insertLatexToCanvas(api, latex, dark);
        toast({ title: t('excalidraw.insert_latex'), tone: 'success' });
    }
}

export function insertNoteCardToCanvas(api: any, noteTitle: string, snippet = '', dark = false): void {
    if (!api || !noteTitle.trim()) return;
    const cleanTitle = noteTitle.trim();
    const center = getViewportCenterInScene(api);
    const settings = useExcalidrawSettingsStore.getState();

    const cardW = settings.mdCardWidth || 280;
    const cardH = snippet ? (settings.mdCardHeight || 160) : Math.min(settings.mdCardHeight || 160, 64);
    const cardX = Math.round(center.x - cardW / 2);
    const cardY = Math.round(center.y - cardH / 2);

    const cardId = `note_card_${Date.now()}`;
    const titleTextId = `note_title_${Date.now()}`;
    const snippetTextId = snippet ? `note_snippet_${Date.now()}` : '';

    const boundElements: { id: string; type: string }[] = [{ id: titleTextId, type: 'text' }];
    if (snippetTextId) {
        boundElements.push({ id: snippetTextId, type: 'text' });
    }

    const rectEl = {
        id: cardId,
        type: 'rectangle',
        x: cardX,
        y: cardY,
        width: cardW,
        height: cardH,
        strokeColor: dark ? '#38bdf8' : '#0284c7',
        backgroundColor: dark ? '#0f172a' : '#f0f9ff',
        fillStyle: 'solid',
        strokeWidth: 1.5,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        roundness: { type: 3 },
        link: `[[${cleanTitle}]]`,
        boundElements,
    };

    const prefix = settings.linkPrefix ? settings.linkPrefix : '📝 ';
    const formattedTitle = settings.linkBrackets ? `[[${cleanTitle}]]` : cleanTitle;
    const titleText = `${prefix}${formattedTitle}`;
    const titleEl = {
        id: titleTextId,
        type: 'text',
        x: cardX + 16,
        y: cardY + 14,
        width: Math.min(cardW - 32, (titleText.length + 2) * 14),
        height: 24,
        text: titleText,
        originalText: titleText,
        fontSize: settings.defaultFontSize || 16,
        fontFamily: settings.defaultFontFamily || 1,
        lineHeight: 1.25,
        textAlign: 'left',
        verticalAlign: 'top',
        strokeColor: dark ? '#f1f5f9' : '#0f172a',
        link: `[[${cleanTitle}]]`,
        containerId: cardId,
    };

    const current = typeof api.getSceneElements === 'function' ? api.getSceneElements() : [];
    const elements = [...current, rectEl, titleEl];

    if (snippet) {
        const snippetEl = {
            id: snippetTextId,
            type: 'text',
            x: cardX + 16,
            y: cardY + 44,
            width: cardW - 32,
            height: 48,
            text: snippet,
            originalText: snippet,
            fontSize: 12,
            fontFamily: 1,
            lineHeight: 1.25,
            textAlign: 'left',
            verticalAlign: 'top',
            strokeColor: dark ? '#94a3b8' : '#64748b',
            containerId: cardId,
        };
        elements.push(snippetEl);
    }

    applySceneElements(api, elements);
}

export async function promptAndInsertNoteCard(api: any, dark = false): Promise<void> {
    const toast = useUi.getState().toast;
    const allNotes = Object.values(useNotes.getState().notes || {}).filter(
        (n) => !n.deletedAt && !n.isArchived
    );

    const placeholder = allNotes[0]?.title || 'Note title...';
    const noteTitle = await prompt({
        title: t('excalidraw.insert_md') || 'Insert Markdown Note:',
        placeholder,
    });
    if (!noteTitle || !noteTitle.trim()) return;

    const trimmed = noteTitle.trim();
    const matchedNote =
        allNotes.find((n) => n.title.toLowerCase() === trimmed.toLowerCase()) ||
        allNotes.find((n) => n.title.toLowerCase().includes(trimmed.toLowerCase()));

    const finalTitle = matchedNote ? matchedNote.title : trimmed;
    let snippet = '';
    if (matchedNote) {
        const rawContent = useNotes.getState().contents[matchedNote.id] || '';
        let cleanContent = rawContent.replace(/^---[\s\S]*?---/, '').trim();
        const settings = useExcalidrawSettingsStore.getState();
        if (settings.parseTODO) {
            cleanContent = cleanContent
                .replace(/^- \[\s\] /gm, `${settings.todo} `)
                .replace(/^- \[[^\s]\] /gm, `${settings.done} `);
        }
        if (cleanContent) {
            snippet = cleanContent.slice(0, 120).replace(/\n+/g, ' ');
            if (cleanContent.length > 120) snippet += '...';
        }
    }

    insertNoteCardToCanvas(api, finalTitle, snippet, dark);
    toast({ title: t('excalidraw.insert_md'), description: `[[${finalTitle}]]`, tone: 'success' });
}

export function insertLinkToCanvas(api: any, linkInput: string, dark = false): void {
    if (!api || !linkInput.trim()) return;
    const rawLink = linkInput.trim();
    const finalLink = /^https?:\/\//i.test(rawLink) || /^mailto:/i.test(rawLink) || /^\[\[/.test(rawLink)
        ? rawLink
        : `[[${rawLink}]]`;

    const appState = (typeof api.getAppState === 'function' ? api.getAppState() : {}) as any;
    const selectedIds = Object.keys(appState.selectedElementIds || {}).filter(
        (id) => appState.selectedElementIds[id]
    );
    const sceneElements = typeof api.getSceneElements === 'function' ? api.getSceneElements() : [];
    const selectedElements = sceneElements.filter(
        (el: any) => selectedIds.includes(el.id) && !el.isDeleted
    );

    if (selectedElements.length > 0) {
        const updated = sceneElements.map((el: any) => {
            if (selectedIds.includes(el.id)) {
                return { ...el, link: finalLink };
            }
            return el;
        });
        applySceneElements(api, updated);
        return;
    }

    const center = getViewportCenterInScene(api);
    const cardW = 240;
    const cardH = 56;
    const cardX = Math.round(center.x - cardW / 2);
    const cardY = Math.round(center.y - cardH / 2);

    const cardId = `link_card_${Date.now()}`;
    const textId = `link_text_${Date.now()}`;
    const isUrl = /^https?:\/\//i.test(rawLink) || /^mailto:/i.test(rawLink);
    const settings = useExcalidrawSettingsStore.getState();
    const prefix = isUrl
        ? (settings.urlPrefix ? settings.urlPrefix : '🌐 ')
        : (settings.linkPrefix ? settings.linkPrefix : '🔗 ');
    const displayLabel = rawLink.replace(/^\[\[/, '').replace(/\]\]$/, '');
    const formattedLabel = (!isUrl && settings.linkBrackets) ? `[[${displayLabel}]]` : displayLabel;
    const linkText = `${prefix}${formattedLabel}`;

    const rectEl = {
        id: cardId,
        type: 'rectangle',
        x: cardX,
        y: cardY,
        width: cardW,
        height: cardH,
        strokeColor: dark ? '#818cf8' : '#4f46e5',
        backgroundColor: dark ? '#1e1b4b' : '#eef2ff',
        fillStyle: 'solid',
        strokeWidth: 1.5,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        roundness: { type: 3 },
        link: finalLink,
        boundElements: [{ id: textId, type: 'text' }],
    };

    const textEl = {
        id: textId,
        type: 'text',
        x: cardX + 16,
        y: cardY + 16,
        width: Math.min(cardW - 32, (linkText.length + 2) * 12),
        height: 24,
        text: linkText,
        originalText: linkText,
        fontSize: settings.defaultFontSize || 14,
        fontFamily: settings.defaultFontFamily || 1,
        lineHeight: 1.25,
        textAlign: 'left',
        verticalAlign: 'middle',
        strokeColor: dark ? '#c7d2fe' : '#312e81',
        link: finalLink,
        containerId: cardId,
    };

    applySceneElements(api, [...sceneElements, rectEl, textEl]);
}

export async function promptAndInsertLink(api: any, dark = false): Promise<void> {
    const toast = useUi.getState().toast;
    const appState = (typeof api.getAppState === 'function' ? api.getAppState() : {}) as any;
    const selectedIds = Object.keys(appState.selectedElementIds || {}).filter(
        (id) => appState.selectedElementIds[id]
    );
    const sceneElements = typeof api.getSceneElements === 'function' ? api.getSceneElements() : [];
    const firstSelected = sceneElements.find(
        (el: any) => selectedIds.includes(el.id) && !el.isDeleted
    );

    const linkInput = await prompt({
        title: t('excalidraw.insert_link') || 'Insert Link:',
        placeholder: 'https://... or [[Note Name]]',
        defaultValue: firstSelected?.link || '',
    });

    if (linkInput && linkInput.trim()) {
        insertLinkToCanvas(api, linkInput, dark);
        toast({ title: t('excalidraw.insert_link'), description: linkInput.trim(), tone: 'success' });
    }
}

export function insertPdfCardToCanvas(api: any, fileName: string, dark = false): void {
    if (!api || !fileName.trim()) return;
    const cleanName = fileName.trim();
    const center = getViewportCenterInScene(api);
    const settings = useExcalidrawSettingsStore.getState();
    const scale = settings.pdfImportScale || 1.0;
    const hasBorder = settings.pdfBorderBox;

    const cardW = Math.round(260 * scale);
    const cardH = Math.round(64 * scale);
    const cardX = Math.round(center.x - cardW / 2);
    const cardY = Math.round(center.y - cardH / 2);

    const cardId = `pdf_card_${Date.now()}`;
    const textId = `pdf_text_${Date.now()}`;
    const pdfText = `📄 ${cleanName}`;

    const rectEl = {
        id: cardId,
        type: 'rectangle',
        x: cardX,
        y: cardY,
        width: cardW,
        height: cardH,
        strokeColor: hasBorder ? (dark ? '#f87171' : '#dc2626') : 'transparent',
        backgroundColor: dark ? '#450a0a' : '#fef2f2',
        fillStyle: 'solid',
        strokeWidth: hasBorder ? 1.5 : 0,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        roundness: { type: 3 },
        link: `[[${cleanName}]]`,
        boundElements: [{ id: textId, type: 'text' }],
    };

    const textEl = {
        id: textId,
        type: 'text',
        x: cardX + 16,
        y: cardY + 18,
        width: Math.min(cardW - 32, (pdfText.length + 2) * 12),
        height: 24,
        text: pdfText,
        originalText: pdfText,
        fontSize: Math.round(14 * Math.min(scale, 1.5)),
        fontFamily: settings.defaultFontFamily || 1,
        lineHeight: 1.25,
        textAlign: 'left',
        verticalAlign: 'middle',
        strokeColor: dark ? '#fecaca' : '#991b1b',
        link: `[[${cleanName}]]`,
        containerId: cardId,
    };

    const sceneElements = typeof api.getSceneElements === 'function' ? api.getSceneElements() : [];
    applySceneElements(api, [...sceneElements, rectEl, textEl]);
}

export function insertEmbedToCanvas(api: any, url: string): void {
    if (!api || !url.trim()) return;
    const center = getViewportCenterInScene(api);
    const embedElement = {
        id: `embed_${Date.now()}`,
        type: 'embeddable',
        x: Math.round(center.x - 200),
        y: Math.round(center.y - 150),
        width: 400,
        height: 300,
        link: url.trim(),
    };
    const sceneElements = typeof api.getSceneElements === 'function' ? api.getSceneElements() : [];
    api.updateScene({ elements: [...sceneElements, embedElement] });
}
