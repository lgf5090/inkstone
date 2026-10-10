import type { AppLocale } from '@shared/types';
import type React from 'react';

export interface ExcalidrawSceneData {
    type?: string;
    version?: number;
    source?: string;
    elements: any[];
    appState?: Record<string, any>;
    files?: Record<string, any>;
}

export interface ExcalidrawFenceRef {
    index: number;
    line?: number;
    rawBody: string;
}

export type ExcalidrawWriteResult = 'written' | 'conflict' | 'missing';

export type ExcalidrawWriter = (ref: ExcalidrawFenceRef, nextBody: string) => ExcalidrawWriteResult;

export interface ExcalidrawMountOptions {
    scope: string;
    noteId: string | null;
    dark: boolean;
    locale: AppLocale;
    editable: boolean;
    writeBack?: ExcalidrawWriter;
}

export interface ExcalidrawBlockEntry {
    id: string;
    container: HTMLElement;
    canvasHost: HTMLElement;
    fence: ExcalidrawFenceRef;
    initialData: ExcalidrawSceneData;
    scope: string;
    noteId: string | null;
    excalidrawAPI: any | null;
    destroy: () => void;
    updateScene: (data: ExcalidrawSceneData) => void;
    zoomToFit: () => void;
    toggleSource: () => void;
    setTheme: (theme: 'light' | 'dark') => void;
}

export interface ExcalidrawLib {
    Excalidraw: React.ComponentType<any>;
    MainMenu: React.ComponentType<any> & {
        DefaultItems: {
            ChangeCanvasBackground: React.ComponentType<any>;
            Preferences: React.ComponentType<any>;
            ToggleTheme: React.ComponentType<any>;
            Help: React.ComponentType<any>;
            ClearCanvas: React.ComponentType<any>;
        };
        Item: React.ComponentType<any>;
        Separator: React.ComponentType<any>;
    };
    WelcomeScreen: React.ComponentType<any> & {
        Center: {
            Heading: React.ComponentType<any>;
            MenuItemLink: React.ComponentType<any>;
        };
    };
    TTDDialog?: React.ComponentType<any>;
    TTDDialogTrigger?: React.ComponentType<any>;
    DiagramToCodePlugin?: React.ComponentType<any>;
    exportToBlob: (options: any) => Promise<Blob>;
    exportToSvg: (options: any) => Promise<SVGSVGElement>;
    exportToClipboard: (options: any) => Promise<void>;
    serializeAsJSON: (elements: any[], appState: any, files: any, type: string) => string;
    restoreElements: (elements: any[], localElements?: any[]) => any[];
    restoreAppState: (appState: any, localAppState?: any) => any;
    getSceneVersion?: (elements: any[]) => number;
    reconcileElements?: (localElements: any[], remoteElements: any[], localAppState: any) => any[];
}
