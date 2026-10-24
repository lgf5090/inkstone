import { QR_BG_COLOR } from '../../attachment-hub/qr-colors';

/**
 * Turning the QR that is on screen into a file or a clipboard image.
 *
 * The code is drawn as SVG, so the vector export is a serialisation, while a bitmap needs the browser
 * to rasterise it through a canvas. The plate is painted first with the code's own background: a PNG
 * that kept the page's background instead would print a code whose quiet zone is whatever colour the
 * theme happened to be wearing.
 */

/** The one file name both exports and the clipboard answer get named by. */
export function qrFileName(title: string, extension: 'png' | 'svg'): string {
  const safe = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  return `${(safe || 'share').toLowerCase().replace(/\s+/g, '-')}-qr.${extension}`;
}

export function downloadQrSvg(svgElement: SVGElement, filename: string): void {
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svgElement)], { type: 'image/svg+xml;charset=utf-8' }));
  triggerDownload(url, filename);
  // Released on the next turn, not the same one: the click only asks for the download, and an object
  // URL revoked before the browser has taken hold of it can leave the file empty.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadQrPng(svgElement: SVGElement, filename: string, size = 800): Promise<boolean> {
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svgElement)], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const canvas = await paintQrToCanvas(url, size, size);
    if (!canvas) return false;
    const blob = await canvasBlob(canvas, 'image/png');
    if (!blob) return false;
    const pngUrl = URL.createObjectURL(blob);
    triggerDownload(pngUrl, filename);
    URL.revokeObjectURL(pngUrl);
    return true;
  }
  finally {
    URL.revokeObjectURL(url);
  }
}

/** A clipboard image, or false when the browser refuses one (an insecure context does). */
export async function copyQrImageToClipboard(svgElement: SVGElement, size = 600): Promise<boolean> {
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svgElement)], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const canvas = await paintQrToCanvas(url, size, size);
    if (!canvas) return false;
    const blob = await canvasBlob(canvas, 'image/png');
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  }
  catch {
    // The image is on screen and the address can still be copied: a refused clipboard write is said
    // out loud by the caller, which is the only half of this the reader can act on.
    return false;
  }
  finally {
    URL.revokeObjectURL(url);
  }
}

/** Rasterise the serialised code, or null when the browser will not draw it or give it back. */
async function paintQrToCanvas(svgUrl: string, width: number, height: number): Promise<HTMLCanvasElement | null> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  const loaded = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = svgUrl;
  });
  if (!loaded) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = QR_BG_COLOR;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}

function triggerDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
