import { useEffect, useState } from 'react'

// Theme flips must reach the slide canvas and its diagrams without going through
// the store, because the canvas renders sanitized markup outside the editor tree.
export function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(() => (document.documentElement.dataset.theme ?? 'dark') === 'dark')
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark((document.documentElement.dataset.theme ?? 'dark') === 'dark')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}
