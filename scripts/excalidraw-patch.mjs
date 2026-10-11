/**
 * The vendored engine build is a minified IIFE that was written for Obsidian, so six of its teardown
 * and asset paths throw when it is hosted by this app instead. The only way in is exact-string
 * replacement on minified text, which fails silently: rename one local and the `.replace()` becomes a
 * no-op that ships an unpatched bundle, and every gate still passes because nothing reads the result.
 *
 * This module is the single source for those edits (they used to be duplicated verbatim in
 * `vite.config.ts` and `scripts/patch-excalidraw.mjs`), and it reports every patch as applied,
 * already-present or unmatched so the caller can refuse to build on a miss.
 */
export const EXCALIDRAW_PATCHES = [
  {
    id: 'font-url-dedupe',
    target: 'return o.push(new URL(t,mu.ASSETS_FALLBACK_URL)),o',
    replacement: 'return(o.length||o.push(new URL(t,this.normalizeBaseUrl(mu.ASSETS_FALLBACK_URL)))),o',
  },
  {
    id: 'assets-fallback-local',
    target: 'F(mu,"ASSETS_FALLBACK_URL",`https://esm.sh/${y.PKG_NAME?`${y.PKG_NAME}@${y.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`);',
    replacement: 'F(mu,"ASSETS_FALLBACK_URL","/vendor/excalidraw/");',
  },
  {
    id: 'canvas-actions-guard',
    target: 'let o=this.app.props.UIOptions.canvasActions;',
    replacement: 'let o=this.app?.props?.UIOptions?.canvasActions;if(!this.app||!o)return null;',
  },
  {
    id: 'unmount-optional-chain',
    target: 'this.unmounted=!0,this.viewport.destroy(),this.removeEventListeners(),this.library.destroy()',
    replacement: 'this.unmounted=!0,this.viewport?.destroy?.(),this.removeEventListeners(),this.library?.destroy?.()',
  },
  {
    id: 'iframerafs-optional',
    target: 'this.iFrameRefs.forEach((i,a)=>{t.has(a)||this.iFrameRefs.delete(a)})',
    replacement: 'this.iFrameRefs?.forEach?.((i,a)=>{t.has(a)||this.iFrameRefs.delete(a)})',
  },
  {
    id: 'canvas-effect-guard',
    target: '(0,AB.useEffect)(()=>{A.canvas.style.width=',
    replacement: '(0,AB.useEffect)(()=>{if(!A?.canvas)return;A.canvas.style.width=',
  },
  {
    id: 'increment-emitters-optional',
    target: 'this.store.onStoreIncrementEmitter.clear(),this.store.onDurableIncrementEmitter.clear()',
    replacement: 'this.store?.onStoreIncrementEmitter?.clear?.(),this.store?.onDurableIncrementEmitter?.clear?.()',
  },
  {
    id: 'did-update-unmounted-guard',
    target: 'componentDidUpdate(t,o){let i=this.renderOverridesUpdatePending;',
    replacement: 'componentDidUpdate(t,o){if(this.unmounted)return;let i=this.renderOverridesUpdatePending;',
  },
  {
    id: 'store-commit-optional',
    target: 'this.store.commit(r,this.state)',
    replacement: 'this.store?.commit?.(r,this.state)',
  },
  {
    id: 'unmount-keeps-fields',
    target: 'this.interactiveCanvas=null,this.iFrameRefs.clear(),this.iFrameRefs=null,this.embedsValidationStatus.clear(),this.embedsValidationStatus=null,this.initializedEmbeds.clear(),this.initializedEmbeds=null,this.elementsPendingErasure.clear(),this.elementsPendingErasure=null,this.lastPointerDownEvent=null,this.lastPointerUpEvent=null,this.lastPointerMoveEvent=null,this.actionManager.app=null,this.actionManager.actions={},this.history.clear(),this.store.clear(),this.store=null,this.library=null,this.canvas=null,this.rc=null,this.excalidrawContainerRef.current=void 0,this.excalidrawContainerValue={container:null,id:"unknown"}',
    replacement: 'this.interactiveCanvas=null,this.iFrameRefs?.clear?.(),this.embedsValidationStatus?.clear?.(),this.initializedEmbeds?.clear?.(),this.elementsPendingErasure?.clear?.(),this.lastPointerDownEvent=null,this.lastPointerUpEvent=null,this.lastPointerMoveEvent=null,this.history?.clear?.(),this.store?.clear?.()',
  },
  {
    id: 'mount-recreates-fields',
    target: 'async componentDidMount(){this.unmounted=!1,this.api=this.createExcalidrawAPI(),',
    replacement: 'async componentDidMount(){if(!this.library)this.library=new DcA(this);if(!this.store)this.store=new Fk(this);if(!this.history)this.history=new gD(this.store);if(!this.elementsPendingErasure)this.elementsPendingErasure=new Set();if(!this.iFrameRefs)this.iFrameRefs=new Map();if(!this.embedsValidationStatus)this.embedsValidationStatus=new Map();if(!this.initializedEmbeds)this.initializedEmbeds=new Set();if(!this.canvas){this.canvas=this.ownerDocument.createElement("canvas");this.rc=xg.canvas(this.canvas);}if(this.actionManager)this.actionManager.app=this;this.unmounted=!1,this.api=this.createExcalidrawAPI(),',
  },
  {
    id: 'update-library-optional',
    target: 'updateLibrary:this.library.updateLibrary,',
    replacement: 'updateLibrary:(...a)=>this.library?.updateLibrary?.(...a),',
  },
  {
    id: 'reset-store-optional',
    target: 'F(this,"resetStore",()=>{this.store.clear()});',
    replacement: 'F(this,"resetStore",()=>{this.store?.clear?.()});',
  },
  {
    id: 'schedule-capture-optional',
    target: 'F(this,"scheduleCapture",()=>this.store.scheduleCapture());',
    replacement: 'F(this,"scheduleCapture",()=>this.store?.scheduleCapture?.());',
  },
  {
    id: 'pending-erasure-size-optional',
    target: 'this.elementsPendingErasure.size&&this.restoreReadyToEraseElements()',
    replacement: '(this.elementsPendingErasure?.size??0)&&this.restoreReadyToEraseElements()',
  },
]

export function applyExcalidrawPatches(source) {
  let content = source
  const applied = []
  const already = []
  const unmatched = []
  for (const patch of EXCALIDRAW_PATCHES) {
    if (content.includes(patch.target)) {
      content = content.replace(patch.target, patch.replacement)
      applied.push(patch.id)
    } else if (content.includes(patch.replacement)) {
      already.push(patch.id)
    } else {
      unmatched.push(patch.id)
    }
  }
  return { content, applied, already, unmatched }
}
