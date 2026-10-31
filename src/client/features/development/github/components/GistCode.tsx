import { useEffect, useRef } from 'react'
import { highlightWithPrism } from '../../../../lib/markdown/prism'

export function GistCode({ content, language }: { content: string; language: string | null }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let cancelled = false
    node.textContent = content
    void highlightWithPrism(content, language ?? '')
      .then((result) => {
        if (!cancelled && result) node.innerHTML = result.html
      })
      .catch((error) => {
        console.warn('[inkstone] Gist code highlighting failed:', error)
      })
    return () => {
      cancelled = true
    }
  }, [content, language])
  return <code ref={ref} className="font-mono" />
}
