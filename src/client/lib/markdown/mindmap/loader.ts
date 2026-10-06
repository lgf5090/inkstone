import { t } from '../../i18n';
import type { MindmapVendor, MindmapVendorLoader } from './types';

const VENDOR_LOAD_TIMEOUT_MS = 15000;

let vendorPromise: Promise<MindmapVendor> | null = null;

/**
 * Loads mind-elixir on demand. The import graph behind ./mind-elixir-vendor holds the
 * library and its stylesheet, so the first mind map block pays for it and a note
 * without one never does; a failure clears the memoized promise so the retry
 * button on the block can try again.
 */
export const loadMindmapVendor: MindmapVendorLoader = () => {
    if (!vendorPromise) {
        const loading = withTimeout(
            import('./mind-elixir-vendor').then((mod) => mod.createMindmapVendor()),
            VENDOR_LOAD_TIMEOUT_MS,
            t('preview.mindmap_render_failed'),
        );
        vendorPromise = loading;
        void loading.catch((err: unknown) => {
            if (vendorPromise === loading)
                vendorPromise = null;
            console.warn('[inkstone] mind map renderer failed to load', err);
        });
    }
    return vendorPromise;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then((value) => {
            window.clearTimeout(timer);
            resolve(value);
        }, (err) => {
            window.clearTimeout(timer);
            reject(err);
        });
    });
}
