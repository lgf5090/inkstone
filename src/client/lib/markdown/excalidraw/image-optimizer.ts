export async function optimizeExcalidrawFile(file: any): Promise<any> {
    if (!file || typeof file.dataURL !== 'string') {
        return file;
    }
    const dataUrl: string = file.dataURL;
    if (dataUrl.startsWith('data:image/svg+xml') || dataUrl.length < 250_000) {
        return file;
    }
    if (typeof document === 'undefined') {
        return file;
    }

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                let { width, height } = img;
                const maxDim = 1600;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(file);
                    return;
                }
                ctx.drawImage(img, 0, 0, width, height);
                const optimizedDataUrl = canvas.toDataURL('image/webp', 0.82);
                if (optimizedDataUrl.length < dataUrl.length) {
                    resolve({
                        ...file,
                        dataURL: optimizedDataUrl,
                        mimeType: 'image/webp',
                    });
                } else {
                    resolve(file);
                }
            } catch {
                resolve(file);
            }
        };
        img.onerror = () => resolve(file);
        img.src = dataUrl;
    });
}

export async function optimizeExcalidrawFiles(
    files: Record<string, any>,
): Promise<{ changed: boolean; files: Record<string, any> }> {
    if (!files || typeof files !== 'object') {
        return { changed: false, files: {} };
    }
    let hasChanges = false;
    const nextFiles: Record<string, any> = {};

    const entries = Object.entries(files);
    for (const [key, file] of entries) {
        const optimized = await optimizeExcalidrawFile(file);
        if (optimized !== file) {
            hasChanges = true;
            nextFiles[key] = optimized;
        } else {
            nextFiles[key] = file;
        }
    }

    return { changed: hasChanges, files: nextFiles };
}
