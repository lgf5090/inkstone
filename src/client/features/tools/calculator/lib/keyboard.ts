import { useEffect } from 'react'
import { CMD } from '@shared/tools/calculator/contract'
import type { CalculatorView } from '@shared/tools/calculator/contract'
import { useCalculatorStore } from '../store'
import { isImeComposing } from '../../../../lib/ime'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

export function useCalculatorKeyboard(view: CalculatorView): void {
  useEffect(() => {
    if (view !== 'standard' && view !== 'scientific' && view !== 'programmer') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeComposing(event) || event.defaultPrevented) return
      if (isTypingTarget(event.target)) return
      const store = useCalculatorStore.getState()
      const mode = store.display.mode
      const send = (command: number) => {
        event.preventDefault()
        store.send(command)
      }
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase()
        if (key === 'h') { event.preventDefault(); store.toggleHistory(); return }
        if (key === 'm') { event.preventDefault(); store.toggleMemory(); return }
        if (key === 'l') { event.preventDefault(); store.clearMemory(); return }
        if (key === 'r') { event.preventDefault(); store.recallMemory(0); return }
        if (key === 'p') { event.preventDefault(); store.addMemory(0); return }
        if (key === 'q') { event.preventDefault(); store.subtractMemory(0); return }
        if (event.shiftKey && key === 'd') { event.preventDefault(); void store.clearHistory(); return }
        return
      }
      if (event.altKey && mode === 'programmer') {
        const map: Record<string, number> = { '1': CMD.qword, '2': CMD.dword, '3': CMD.word, '4': CMD.byte, '5': CMD.hex, '6': CMD.dec, '7': CMD.oct, '8': CMD.bin }
        const command = map[event.key]
        if (command) send(command)
        return
      }
      if (event.altKey) return
      if (/^[0-9]$/.test(event.key)) { send(CMD.digit0 + Number(event.key)); return }
      if (event.key === '.' || event.key === ',') { send(CMD.decimal); return }
      if (mode === 'programmer' && /^[a-fA-F]$/.test(event.key)) { send(CMD.a + (event.key.toUpperCase().charCodeAt(0) - 65)); return }
      switch (event.key) {
        case '+': send(CMD.add); return
        case '-': send(CMD.subtract); return
        case '*': send(CMD.multiply); return
        case '/': send(CMD.divide); return
        case '%': send(mode === 'programmer' ? CMD.mod : CMD.percent); return
        case '^': send(mode === 'programmer' ? CMD.xor : CMD.power); return
        case '@': if (mode !== 'programmer') send(CMD.sqrt); return
        case '(': send(CMD.openParen); return
        case ')': send(CMD.closeParen); return
        case 'Enter':
        case '=': send(CMD.equals); return
        case 'Escape': send(CMD.clear); return
        case 'Backspace': send(CMD.back); return
        case 'Delete': send(CMD.clearEntry); return
        case 'F9': send(CMD.sign); return
        default: break
      }
      if (mode === 'standard' || mode === 'scientific') {
        const key = event.key.toLowerCase()
        if (key === 'r') { send(CMD.reciprocal); return }
        if (key === 'q') { send(CMD.square); return }
        if (key === 'p') { send(CMD.pi); return }
        if (key === 'e') { send(CMD.euler); return }
        if (mode === 'scientific') {
          if (key === 's' && !event.shiftKey) { send(CMD.sin); return }
          if (key === 'o' && !event.shiftKey) { send(CMD.cos); return }
          if (key === 't' && !event.shiftKey) { send(CMD.tan); return }
          if (key === 'l') { send(CMD.log); return }
          if (key === 'n') { send(CMD.ln); return }
          if (key === 's' && event.shiftKey) { send(CMD.asin); return }
          if (key === 'o' && event.shiftKey) { send(CMD.acos); return }
          if (key === 't' && event.shiftKey) { send(CMD.atan); return }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view])
}
