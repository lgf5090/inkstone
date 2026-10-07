/**
 * Shared fixture for the two label probes: both mount the real surface once per shipped language and
 * compare the rendered text with the resource entry itself — the expectation is read out of
 * `EN_US_MESSAGES`/`ZH_CN_MESSAGES` with only the caller's value substituted, so a resource rewrite
 * moves the test with it and a component that slides back to composing labels in JSX goes red.
 * Han literals cannot appear in a test file (`i18n:check` only allows them inside the zh-CN
 * resources), which is why the phrase is always looked up rather than written out.
 */
import { act, type ReactElement } from 'react'
import { afterEach, beforeAll } from 'vitest'
import { EN_US_MESSAGES } from '../../../../../shared/locales/en-US'
import { ZH_CN_MESSAGES } from '../../../../../shared/locales/zh-CN'
import { initI18n, setLocale } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'

export const LOCALES = ['en-US', 'zh-CN'] as const
export type LocaleCode = (typeof LOCALES)[number]

const RESOURCES: Record<LocaleCode, Record<string, string | undefined>> = {
  'en-US': EN_US_MESSAGES,
  'zh-CN': ZH_CN_MESSAGES,
}

/** The phrase as the resource file has it, with only the caller's value in the placeholder. */
export function messageIn(code: LocaleCode, key: string, params: Record<string, string | number> = {}): string {
  const template = RESOURCES[code][key]
  if (template === undefined)
    throw new Error(`${key} is not a message in the ${code} resource`)
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => String(params[name]))
}

export async function inLocale(code: LocaleCode): Promise<void> {
  await act(async () => {
    await setLocale(code, false)
  })
}

const mounted: { unmount: () => void }[] = []

export async function mountIn(code: LocaleCode, element: ReactElement): Promise<HTMLElement> {
  await inLocale(code)
  const rendered = renderElement(element)
  mounted.push(rendered)
  return rendered.container
}

/** Registers what both probes need: i18n ready before the first case, every mount torn down after each. */
export function installBilingualLabelHooks(): void {
  beforeAll(async () => {
    installTestGlobals()
    await initI18n()
  })
  afterEach(() => {
    while (mounted.length)
      mounted.pop()!.unmount()
  })
}
