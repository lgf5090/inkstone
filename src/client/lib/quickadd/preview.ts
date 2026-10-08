/**
 * A format runtime that cannot touch the app, for the settings preview.
 *
 * The editor shows what a format will become while the author is still typing it. That has to run the
 * real formatter — a second, simpler implementation would drift from the engine and tell the author
 * their format is fine when it is not — but every seam that could ask a question, read the clipboard
 * or write a note is replaced by an answer that does nothing. A prompt-shaped token therefore renders
 * its own default text, and a macro or included template renders nothing at all.
 */
import type { QuickAddChoice, QuickAddSettings } from '@shared/quickadd'
import { globalVarMap, periodicNote } from './runtime'
import { formatDatePattern } from './date-pattern'
import type { FormatRuntime, PromptAnswer } from './format'

export interface PreviewContext {
  settings: QuickAddSettings
  choices: QuickAddChoice[]
  /** The note the preview should pretend to be about; a title the author will recognise. */
  title: string
  locale: string
  now?: Date
  selection?: string
}

/**
 * The runtime, with `templateBody` and `fieldValues` left to the caller: those two need the note
 * library, and a preview that fetched them on every keystroke would be a search box in disguise.
 */
export function previewRuntime(context: PreviewContext, extra: Partial<FormatRuntime> = {}): FormatRuntime {
  const now = context.now ?? new Date()
  const variables = new Map<string, PromptAnswer>()
  return {
    variables,
    globalVars: globalVarMap(context.settings),
    locale: context.locale,
    clock: { now, date: now },
    defaults: { dateFormat: context.settings.dateFormat, timeFormat: context.settings.timeFormat },
    title: context.title,
    folderPath: context.settings.defaultFolder || null,
    activeTitle: context.title,
    activeFolderPath: context.settings.defaultFolder || null,
    selection: context.selection ?? '',
    clipboard: async () => '',
    linkToActive: (subpath) => `[[${context.title}]]${subpath ?? ''}`,
    cursorHeadingPath: () => null,
    // A preview never asks, so a prompt-shaped token renders the default the reader would have been offered.
    prompt: async (request) => request.defaultValue,
    templateBody: () => Promise.resolve(null),
    runMacroByName: async () => '',
    fieldValues: async () => [],
    pickFile: async () => null,
    periodicPath: (period, offset, link) => {
      const note = periodicNote(context.settings, period, { now, date: now }, offset)
      return link ? `[[${note.title}]]` : note.folder ? `${note.folder}/${note.title}` : note.title
    },
    warn: () => {},
    ...extra,
  }
}

/** The date-formatter half, for the format-field hint line under the date inputs. */
export function previewDateFormat(pattern: string, locale: string, now = new Date()): string {
  return formatDatePattern(now, pattern || 'YYYY-MM-DD', { locale })
}
