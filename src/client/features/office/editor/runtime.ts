/**
 * One Univer instance's lifetime, shared by the three P1 editors.
 *
 * The product modules own what a product is: its packages, its plugin order, its locale CSS and the one
 * call that opens a snapshot. This module owns what every product needs the same way — the license
 * first, theme and language, the disposed-in-a-microtask teardown that survives StrictMode, the handle
 * the shell and the assistant share, and the save loop wired to the events Univer actually fires.
 */
import {
  CommandType,
  LocaleType,
  Univer,
  UserManagerService,
  type IUser,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverLicensePlugin } from '@univerjs-pro/license'
import { defaultTheme } from '@univerjs/themes'
import type { AppLocale } from '@shared/types'
import type { OfficeEditPlan } from '@shared/office/ai'
import { validateOfficeEditPlan } from '@shared/office/ai'
import type { OfficeFileType } from '@shared/office/constants'
import type { OfficeSnapshot } from '@shared/office/model'
import { t } from '../../../lib/i18n'
import { useSession } from '../../../store/session'
import { officeAutosaveDelay, officeLicense, officeUsesProPackages } from '../office-build'
import { createOfficeAutosave, type OfficeSaveState } from './autosave'
import type { OfficeEditorContext, OfficeEditorHandle } from './contracts'
import { registerOfficeEditorHandle } from './handles'

export { getOfficeEditorHandle, registerOfficeEditorHandle } from './handles'

/** The pointer a screen reports after a selection, kept off the command path on purpose. */
const CONTEXT_THROTTLE_MS = 250

/**
 * `ILocales` is the shape the constructor takes but is not re-exported by `@univerjs/core`, so it is read
 * from the one declaration that owns it rather than restated here (a restatement would stop compiling
 * the day the package widens it).
 */
type UniverLocales = NonNullable<NonNullable<ConstructorParameters<typeof Univer>[0]>['locales']>

export interface OfficeEditorUnit {
  /** The Univer unit id; mutations of this unit are the ones that write the snapshot. */
  readonly unitId: string
  save(): OfficeSnapshot
  context(): OfficeEditorContext
}

export interface OfficeEditorUnitInput {
  fileId: string
  title: string
  /** The stored snapshot, or `null` for a file that has never been saved. */
  snapshot: OfficeSnapshot | null
}

export interface OfficeEditorProductContext {
  container: HTMLElement
  /** `lite` registers the open-source packages only, which is also what removes the Pro watermark. */
  build: 'full' | 'lite'
}

export interface OfficeEditorProduct {
  /** Both languages, merged from every package this product loads. */
  readonly locales: UniverLocales
  /** Register this product's plugins in the order the product's installation page states. */
  register(univer: Univer, context: OfficeEditorProductContext): void
  /** Create or restore the unit and return the operations the shared handle needs. */
  create(api: FUniver, input: OfficeEditorUnitInput): OfficeEditorUnit
  /** Apply a validated assistant plan through this product's Facade surface. */
  applyPlan?(api: FUniver, plan: OfficeEditPlan): Promise<void>
  /** Pro products register the license plugin before their own plugins. */
  readonly needsLicense?: boolean
}

/**
 * What the shell and the assistant may call. Everything on `OfficeEditorHandle` is here unchanged; the
 * rest is the editor's own surface (theme/language/conflict), which the frozen contract does not cover.
 */
export interface OfficeEditorInstance extends OfficeEditorHandle {
  readonly unitId: string
  setLocale(locale: AppLocale): void
  /** A failed save, on the reader's request. */
  retrySave(): void
  /** After the reader chose to replace the newer revision, write with it. */
  overwriteConflict(currentRev: number): void
  dispose(): void
}

export interface MountOfficeEditorOptions {
  type: OfficeFileType
  host: HTMLElement
  fileId: string
  title: string
  snapshot: OfficeSnapshot | null
  /** The revision the snapshot belongs to; every save is conditional on it. */
  baseRev: number
  locale: AppLocale
  dark: boolean
  product: OfficeEditorProduct
  onReady?: (handle: OfficeEditorHandle) => void
  onContext?: (context: OfficeEditorContext) => void
  onError?: (message: string) => void
  onSaveState?: (state: OfficeSaveState) => void
  onConflict?: (currentRev: number) => void
  onAssetFailure?: (failed: number) => void
}

function univerLocale(locale: AppLocale): LocaleType {
  return locale === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US
}

/** Comment authors and avatars are read from the session; without this every thread has no author. */
function applySessionUser(univer: Univer): void {
  const user = useSession.getState().user
  if (!user) return
  const current: IUser = {
    // The local authz mock derives the role from the user id prefix.
    userID: `Owner_${user.id}`,
    name: user.name || user.login,
    ...(user.avatarUrl ? { avatar: user.avatarUrl } : {}),
  }
  univer.__getInjector().get(UserManagerService).setCurrentUser(current)
}

function commandUnitId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const unitId = (params as { unitId?: unknown }).unitId
  return typeof unitId === 'string' ? unitId : null
}

export function mountOfficeEditor(options: MountOfficeEditorOptions): OfficeEditorInstance {
  const container = document.createElement('div')
  container.style.height = '100%'
  container.style.width = '100%'
  options.host.appendChild(container)

  const univer = new Univer({
    locale: univerLocale(options.locale),
    locales: options.product.locales,
    // Dark mode is Univer's own token block (`.univer-dark`); passing an accent theme alongside it also
    // overrides the gray scale the stylesheet's `dark:` utilities assume, which paints the workbench
    // light. A light editor keeps the shared default theme.
    ...(options.dark ? {} : { theme: defaultTheme }),
  })

  // First, before any Pro package registers: a dependency registered on our behalf carries no license.
  const license = officeLicense()
  if (options.product.needsLicense) univer.registerPlugin(UniverLicensePlugin, { license })
  options.product.register(univer, { container, build: officeUsesProPackages() ? 'full' : 'lite' })
  applySessionUser(univer)

  const api = FUniver.newAPI(univer)
  let disposed = false
  let ready = false
  let contextTimer: number | undefined
  let unregisterHandle: (() => void) | null = null
  let handleRef: OfficeEditorInstance | null = null
  let renderedBeforeHandle = false

  function markReady(instance: OfficeEditorInstance): void {
    if (disposed || ready) return
    ready = true
    unregisterHandle = registerOfficeEditorHandle(options.fileId, instance)
    options.onReady?.(instance)
    options.onContext?.(instance.context())
  }

  // Subscribed before the product creates its unit: a product whose first frame renders inside `create`
  // reports Rendered before a handle exists, and for that product it is the only report there is.
  const lifecycle = api.addEvent(api.Event.LifeCycleChanged, (event) => {
    if (disposed || ready || event.stage !== api.Enum.LifecycleStages.Rendered) return
    if (!handleRef) {
      renderedBeforeHandle = true
      return
    }
    markReady(handleRef)
  })

  const unit = options.product.create(api, {
    fileId: options.fileId,
    title: options.title,
    snapshot: options.snapshot,
  })

  // The constructor's `darkMode` only seeds the model; the theme service is what the UI reads, so the
  // reader's choice is applied once the instance exists (a flip remounts under the new value).
  api.toggleDarkMode(options.dark)

  const autosave = createOfficeAutosave({
    fileId: options.fileId,
    baseRev: options.baseRev,
    initialSnapshot: options.snapshot,
    readSnapshot: () => unit.save(),
    subscribe(listener) {
      const event = api.addEvent(api.Event.CommandExecuted, (command) => {
        // Only mutations reach the snapshot; selections and scrolling are operations and would otherwise
        // arm a save on every click. A document editor's own input units mutate under another unit id.
        if (command.type !== CommandType.MUTATION) return
        const target = commandUnitId(command.params)
        if (target !== null && target !== unit.unitId) return
        listener()
      })
      return () => event.dispose()
    },
    onStateChange: options.onSaveState,
    onConflict: (currentRev) => options.onConflict?.(currentRev),
    onAssetFailure: options.onAssetFailure,
    delayMs: officeAutosaveDelay(),
  })

  const handle: OfficeEditorInstance = {
    unitId: unit.unitId,
    save: () => unit.save(),
    flush: () => autosave.flush(),
    undo() {
      // The facade targets the focused unit; each editor instance owns exactly one product unit.
      void api.undo().then((done) => {
        if (done) autosave.markDirty()
      }).catch((error: unknown) => {
        // An undo that cannot run leaves the document as it was; the reader's next action is the report.
        console.warn('[office] undo failed', error)
      })
    },
    async applyPlan(plan: OfficeEditPlan): Promise<void> {
      const validation = validateOfficeEditPlan(plan, { type: options.type, fileId: options.fileId })
      if (!validation.ok) throw new Error(validation.error)
      if (!options.product.applyPlan) throw new Error(t('office.ai.failed'))
      await options.product.applyPlan(api, validation.plan)
      autosave.markDirty()
      await autosave.flush()
    },
    context: () => ({
      ...unit.context(),
      saveState: autosave.state(),
      baseRev: autosave.baseRev(),
    }),
    setLocale: (locale) => api.setLocale(univerLocale(locale)),
    retrySave: () => autosave.retry(),
    overwriteConflict: (currentRev) => autosave.overwrite(currentRev),
    dispose,
  }

  handleRef = handle
  if (renderedBeforeHandle) markReady(handle)

  // Selection moves are operations, filtered out of the save listener above, so the page pointer gets its
  // own read: a reader dragging across a table should not leave the assistant's context at the old range.
  const contextEvents = api.addEvent(api.Event.CommandExecuted, () => {
    if (disposed || !ready || contextTimer !== undefined) return
    contextTimer = window.setTimeout(() => {
      contextTimer = undefined
      if (disposed) return
      options.onContext?.(handle.context())
    }, CONTEXT_THROTTLE_MS)
  })

  function dispose(): void {
    if (disposed) return
    disposed = true
    autosave.dispose()
    if (contextTimer !== undefined) window.clearTimeout(contextTimer)
    contextEvents.dispose()
    lifecycle.dispose()
    const unregister = unregisterHandle
    unregisterHandle = null
    unregister?.()
    // A StrictMode mount runs its cleanup in the same tick as the next mount. Deferring the teardown
    // lets a pending save read the model first, and keeps the second instance's container untouched.
    queueMicrotask(() => {
      try {
        univer.dispose()
      } catch (error) {
        // The container is detached either way; an instance that refuses to dispose must not stop the
        // editor that replaced it.
        console.warn('[office] editor dispose failed', error)
      } finally {
        container.remove()
      }
    })
  }

  return handle
}