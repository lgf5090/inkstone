import { useEffect, useRef, type ComponentType } from 'react'
import { LocaleType, Univer, mergeLocales } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { darkBlueTheme, defaultTheme } from '@univerjs/themes'
import type { OfficeEditPlan } from '@shared/office/ai'
import type { OfficeFileType } from '@shared/office/constants'
import type { OfficeSnapshot } from '@shared/office/model'
import { findInlineOfficeImages, replaceInlineOfficeImages, sha256Hex } from '@shared/office/snapshot'
import { ApiError } from '../../../lib/api'
import { t, useLocale } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { officeApi } from '../api'
import type { OfficeEditorContext, OfficeEditorHandle, OfficeEditorProps } from './contracts'
import { registerOfficeEditorHandle } from './handles'

export type OfficeSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed'

export interface OfficeProductAdapter {
  type: OfficeFileType
  locales: { en: Record<string, unknown>; zh: Record<string, unknown> }
  registerPlugins(univer: Univer, container: HTMLElement, license: string): void
  createUnit(api: FUniver, snapshot: OfficeSnapshot | null, fileId: string, title: string): void
  save(api: FUniver): OfficeSnapshot
  undo(api: FUniver): void
  applyPlan(api: FUniver, plan: OfficeEditPlan): Promise<void>
  context(api: FUniver): OfficeEditorContext
}

export interface OfficeUniverEditorProps extends OfficeEditorProps {
  onDirtyChange?: (dirty: boolean) => void
  onSaveState?: (state: OfficeSaveState) => void
}

const AUTOSAVE_DELAY = 1200

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
}

/**
 * One lifecycle for every product: create the instance, register the product's plugins, restore the
 * snapshot, then keep the autosave loop running until the component goes away.
 */
export function createOfficeUniverEditor(adapter: OfficeProductAdapter): ComponentType<OfficeUniverEditorProps> {
  return function OfficeUniverEditor({
    fileId,
    title,
    snapshot,
    onReady,
    onContext,
    onError,
    onDirtyChange,
    onSaveState,
  }: OfficeUniverEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null)
    const callbacks = useRef({ onReady, onContext, onError, onDirtyChange, onSaveState })
    callbacks.current = { onReady, onContext, onError, onDirtyChange, onSaveState }
    const locale = useLocale()
    const localeRef = useRef(locale)
    const dirtyRef = useRef(false)
    const lastHash = useRef('')
    const saveTimer = useRef<number | undefined>(undefined)
    const saveChain = useRef<Promise<void>>(Promise.resolve())
    const baseRev = useRef(0)
    const readyRef = useRef(false)
    const apiRef = useRef<FUniver | null>(null)

    useEffect(() => {
      localeRef.current = locale
    }, [locale])

    useEffect(() => {
      const host = hostRef.current
      if (!host) return
      const container = document.createElement('div')
      container.style.height = '100%'
      host.appendChild(container)

      let disposed = false
      let disposableLifecycle: { dispose(): void } | undefined
      let disposableCommands: { dispose(): void } | undefined
      let observer: MutationObserver | undefined
      let unregister: (() => void) | undefined

      const dark = isDark()
      const initialLocale = localeRef.current === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US
      const univer = new Univer({
        locale: initialLocale,
        locales: {
          [LocaleType.EN_US]: mergeLocales(adapter.locales.en),
          [LocaleType.ZH_CN]: mergeLocales(adapter.locales.zh),
        },
        theme: dark ? darkBlueTheme : defaultTheme,
        darkMode: dark,
      })

      let api: FUniver | null = null
      const setDirty = (dirty: boolean) => {
        if (dirtyRef.current === dirty) return
        dirtyRef.current = dirty
        callbacks.current.onDirtyChange?.(dirty)
        if (!dirty) callbacks.current.onSaveState?.('idle')
      }
      const fail = (message: string) => {
        callbacks.current.onSaveState?.('failed')
        useUi.getState().toast({ title: t('office.save.failed'), description: message, tone: 'danger' })
      }

      const flush = (): Promise<void> => {
        if (!api || !readyRef.current) return saveChain.current
        saveChain.current = saveChain.current.then(async () => {
          if (disposed) return
          callbacks.current.onSaveState?.('saving')
          try {
            const current = adapter.save(api!)
            const inline = findInlineOfficeImages(current)
            const mapping = new Map<string, string>()
            for (let index = 0; index < inline.length; index += 3) {
              await Promise.all(inline.slice(index, index + 3).map(async (image) => {
                const response = await fetch(image.dataUrl)
                const blob = await response.blob()
                const extension = image.mime.split('/')[1] ?? 'png'
                const file = new File([blob], `inline-${index}.${extension}`, { type: image.mime })
                const asset = await officeApi.uploadAsset(file)
                mapping.set(image.dataUrl, officeApi.assetUrl(asset.id))
              }))
            }
            const withAssets = mapping.size ? replaceInlineOfficeImages(current, mapping) as OfficeSnapshot : current
            const text = JSON.stringify(withAssets)
            const hash = await sha256Hex(text)
            if (hash === lastHash.current) {
              setDirty(false)
              callbacks.current.onSaveState?.('saved')
              return
            }
            const result = await officeApi.saveSnapshot(fileId, baseRev.current, withAssets)
            baseRev.current = result.rev
            lastHash.current = hash
            setDirty(false)
            callbacks.current.onSaveState?.('saved')
            callbacks.current.onContext?.(adapter.context(api!))
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              useUi.getState().toast({
                title: t('office.conflict.title'),
                description: t('office.conflict.description'),
                tone: 'danger',
                action: { label: t('office.conflict.reload'), run: () => window.location.reload() },
              })
              callbacks.current.onSaveState?.('failed')
              return
            }
            fail(error instanceof Error ? error.message : String(error))
            throw error
          }
        }).catch(() => {
          // The failure was already shown; the chain must stay usable for the next edit.
        })
        return saveChain.current
      }

      const schedule = () => {
        if (!readyRef.current) return
        setDirty(true)
        callbacks.current.onSaveState?.('dirty')
        window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => { void flush() }, AUTOSAVE_DELAY)
      }

      try {
        adapter.registerPlugins(univer, container, import.meta.env.VITE_UNIVER_LICENSE ?? '')
        api = FUniver.newAPI(univer)
        apiRef.current = api
        adapter.createUnit(api, snapshot, fileId, title)

        const handle: OfficeEditorHandle = {
          save: () => adapter.save(api!),
          flush,
          undo: () => {
            adapter.undo(api!)
            schedule()
          },
          applyPlan: async (plan) => {
            if (plan.fileId !== fileId || plan.type !== adapter.type) {
              throw new Error(t('office.ai.failed'))
            }
            await adapter.applyPlan(api!, plan)
            schedule()
            await flush()
          },
          context: () => adapter.context(api!),
        }
        unregister = registerOfficeEditorHandle(fileId, handle)

        disposableLifecycle = api.addEvent(api.Event.LifeCycleChanged, ({ stage }) => {
          if (stage !== api!.Enum.LifecycleStages.Rendered) return
          readyRef.current = true
          callbacks.current.onReady?.(handle)
          callbacks.current.onContext?.(adapter.context(api!))
        })
        disposableCommands = api.addEvent(api.Event.CommandExecuted, () => {
          if (!readyRef.current) return
          schedule()
          callbacks.current.onContext?.(adapter.context(api!))
        })

        officeApi.snapshot(fileId).then((result) => {
          if (!disposed) baseRev.current = result.rev
        }).catch(() => {
          // The host already loaded the snapshot; a missing revision is treated as the first save.
        })

        observer = new MutationObserver(() => {
          if (!api || disposed) return
          api.toggleDarkMode(isDark())
        })
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

        const onBeforeUnload = (event: BeforeUnloadEvent) => {
          if (!dirtyRef.current) return
          event.preventDefault()
          event.returnValue = ''
        }
        window.addEventListener('beforeunload', onBeforeUnload)

        return () => {
          disposed = true
          readyRef.current = false
          window.clearTimeout(saveTimer.current)
          window.removeEventListener('beforeunload', onBeforeUnload)
          observer?.disconnect()
          unregister?.()
          disposableCommands?.dispose()
          disposableLifecycle?.dispose()
          apiRef.current = null
          // StrictMode disposes the first mount immediately; deferring keeps the second mount's
          // container untouched until this one has released it.
          queueMicrotask(() => {
            univer.dispose()
            container.remove()
          })
        }
      } catch (error) {
        univer.dispose()
        container.remove()
        callbacks.current.onError?.(error instanceof Error ? error.message : String(error))
        return
      }
    }, [adapter, fileId, snapshot, title])

    useEffect(() => {
      const api = apiRef.current
      if (!api || !readyRef.current) return
      const next = locale === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US
      api.loadLocales(next, next === LocaleType.ZH_CN ? mergeLocales(adapter.locales.zh) : mergeLocales(adapter.locales.en))
      api.setLocale(next)
    }, [adapter, locale])

    return <div ref={hostRef} className="h-full min-h-0" data-office-editor={adapter.type} />
  }
}