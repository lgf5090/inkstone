import fs from 'node:fs'
import path from 'node:path'

const vendorJsPath = path.resolve('node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.js')

if (fs.existsSync(vendorJsPath)) {
  let content = fs.readFileSync(vendorJsPath, 'utf8')

  content = content.replace(
    'return o.push(new URL(t,mu.ASSETS_FALLBACK_URL)),o',
    'return(o.length||o.push(new URL(t,this.normalizeBaseUrl(mu.ASSETS_FALLBACK_URL)))),o',
  )

  const fallbackTarget = 'F(mu,"ASSETS_FALLBACK_URL",`https://esm.sh/${y.PKG_NAME?`${y.PKG_NAME}@${y.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`);'
  if (content.includes(fallbackTarget)) {
    content = content.replace(fallbackTarget, 'F(mu,"ASSETS_FALLBACK_URL","/vendor/excalidraw/");')
  }

  content = content.replace(
    'let o=this.app.props.UIOptions.canvasActions;',
    'let o=this.app?.props?.UIOptions?.canvasActions;if(!this.app||!o)return null;',
  )

  content = content.replace(
    'this.unmounted=!0,this.viewport.destroy(),this.removeEventListeners(),this.library.destroy()',
    'this.unmounted=!0,this.viewport?.destroy?.(),this.removeEventListeners(),this.library?.destroy?.()',
  )

  content = content.replace(
    'this.iFrameRefs.forEach((i,a)=>{t.has(a)||this.iFrameRefs.delete(a)})',
    'this.iFrameRefs?.forEach?.((i,a)=>{t.has(a)||this.iFrameRefs.delete(a)})',
  )

  content = content.replace(
    '(0,AB.useEffect)(()=>{A.canvas.style.width=',
    '(0,AB.useEffect)(()=>{if(!A?.canvas)return;A.canvas.style.width=',
  )

  content = content.replace(
    'this.store.onStoreIncrementEmitter.clear(),this.store.onDurableIncrementEmitter.clear()',
    'this.store?.onStoreIncrementEmitter?.clear?.(),this.store?.onDurableIncrementEmitter?.clear?.()',
  )

  content = content.replace(
    'componentDidUpdate(t,o){let i=this.renderOverridesUpdatePending;',
    'componentDidUpdate(t,o){if(this.unmounted)return;let i=this.renderOverridesUpdatePending;',
  )

  content = content.replace(
    'this.store.commit(r,this.state)',
    'this.store?.commit?.(r,this.state)',
  )

  const unmountTarget = 'this.interactiveCanvas=null,this.iFrameRefs.clear(),this.iFrameRefs=null,this.embedsValidationStatus.clear(),this.embedsValidationStatus=null,this.initializedEmbeds.clear(),this.initializedEmbeds=null,this.elementsPendingErasure.clear(),this.elementsPendingErasure=null,this.lastPointerDownEvent=null,this.lastPointerUpEvent=null,this.lastPointerMoveEvent=null,this.actionManager.app=null,this.actionManager.actions={},this.history.clear(),this.store.clear(),this.store=null,this.library=null,this.canvas=null,this.rc=null,this.excalidrawContainerRef.current=void 0,this.excalidrawContainerValue={container:null,id:"unknown"}'
  if (content.includes(unmountTarget)) {
    content = content.replace(
      unmountTarget,
      'this.interactiveCanvas=null,this.iFrameRefs?.clear?.(),this.embedsValidationStatus?.clear?.(),this.initializedEmbeds?.clear?.(),this.elementsPendingErasure?.clear?.(),this.lastPointerDownEvent=null,this.lastPointerUpEvent=null,this.lastPointerMoveEvent=null,this.history?.clear?.(),this.store?.clear?.()',
    )
  }

  const mountTarget = 'async componentDidMount(){this.unmounted=!1,this.api=this.createExcalidrawAPI(),'
  if (content.includes(mountTarget)) {
    content = content.replace(
      mountTarget,
      'async componentDidMount(){if(!this.library)this.library=new DcA(this);if(!this.store)this.store=new Fk(this);if(!this.history)this.history=new gD(this.store);if(!this.elementsPendingErasure)this.elementsPendingErasure=new Set();if(!this.iFrameRefs)this.iFrameRefs=new Map();if(!this.embedsValidationStatus)this.embedsValidationStatus=new Map();if(!this.initializedEmbeds)this.initializedEmbeds=new Set();if(!this.canvas){this.canvas=this.ownerDocument.createElement("canvas");this.rc=xg.canvas(this.canvas);}if(this.actionManager)this.actionManager.app=this;this.unmounted=!1,this.api=this.createExcalidrawAPI(),',
    )
  }

  content = content.replace(
    'updateLibrary:this.library.updateLibrary,',
    'updateLibrary:(...a)=>this.library?.updateLibrary?.(...a),',
  )

  content = content.replace(
    'F(this,"resetStore",()=>{this.store.clear()});',
    'F(this,"resetStore",()=>{this.store?.clear?.()});',
  )

  content = content.replace(
    'F(this,"scheduleCapture",()=>this.store.scheduleCapture());',
    'F(this,"scheduleCapture",()=>this.store?.scheduleCapture?.());',
  )

  content = content.replace(
    'this.elementsPendingErasure.size&&this.restoreReadyToEraseElements()',
    '(this.elementsPendingErasure?.size??0)&&this.restoreReadyToEraseElements()',
  )

  fs.writeFileSync(vendorJsPath, content, 'utf8')
}
