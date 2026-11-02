import type { CalculatorMode, Radix } from '@shared/tools/calculator/contract'
import { parsePasteCommands } from '@shared/tools/calculator/engine/paste'
import { calcT } from './calc-i18n'

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function pasteIntoCalculator(
  mode: CalculatorMode,
  radix: Radix,
  send: (command: number) => void,
): Promise<{ ok: boolean; message?: string }> {
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    return { ok: false, message: calcT('tools.calculator.error.paste_invalid') }
  }
  const parsed = parsePasteCommands(text, mode, radix)
  if (!parsed.ok) return { ok: false, message: calcT(`tools.calculator.error.${parsed.errorKey ?? 'paste_invalid'}`) }
  for (const command of parsed.commands) send(command)
  return { ok: true }
}
