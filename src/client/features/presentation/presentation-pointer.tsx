import { useEffect, useRef } from 'react'

// What a talk points with: an operating-system cursor is a speck on a projector and a screen
// share resamples it into a blur, while a red dot with a smear behind it survives both. Nothing
// here paints per frame — the layer holds the coordinates and CSS moves the dots to them, so the
// colour comes from `--danger` and the motion from the theme's own durations.
//
// The styling lives in `.laser-*` in `styles/presentation.css`, which carries no comments of its
// own, so the reading of it belongs here: the three trails hold the same coordinates and differ
// only in `transition-duration`, which is what makes the lag read as a smear rather than as three
// dots; the stylesheet parks a marker off-screen through `var(--laser-x, -100vw)` for a layer that
// is present but not on, and turning a tool on writes a starting position into it (see the tracker)
// so "on" is never invisible; `pointer-events: none` is what keeps a click on the slide a click on
// the slide; and the pulse is taken out under `prefers-reduced-motion` rather than shortened,
// because its duration is built from `--dur-slow` and that token drops to 1ms, which would strobe
// instead of breathe.
function usePointerTracker(active: boolean, varX: string, varY: string) {
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return
    // The stylesheet parks the marker off-screen until a coordinate is written, which is the right
    // default for a layer that is merely present and the wrong one for a tool that is on: the laser
    // hides the operating-system cursor while it runs, so a talk turned on from the keyboard, or a
    // presenter whose hand is still, got a projector with no cursor and no dot — and the spotlight,
    // being a mask, dimmed the whole slide with no clear circle to aim at. Centre it and the tool
    // announces itself; the first real move takes over on the next frame.
    const layer = layerRef.current
    layer?.style.setProperty(varX, `${Math.round(window.innerWidth / 2)}px`)
    layer?.style.setProperty(varY, `${Math.round(window.innerHeight / 2)}px`)
    let frame = 0
    let x = 0
    let y = 0
    const paint = () => {
      frame = 0
      const layer = layerRef.current
      if (!layer) return
      layer.style.setProperty(varX, `${x}px`)
      layer.style.setProperty(varY, `${y}px`)
    }
    // One write per frame whatever the pointer did in between: a trackpad reports an event per
    // hardware tick, and a dot that reads them all ends up in the same place anyway.
    const track = (event: PointerEvent) => {
      x = event.clientX
      y = event.clientY
      if (!frame) frame = requestAnimationFrame(paint)
    }
    window.addEventListener('pointermove', track)
    return () => {
      window.removeEventListener('pointermove', track)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [active, varX, varY])

  return layerRef
}

export function LaserPointer({ active }: { active: boolean }) {
  const layerRef = usePointerTracker(active, '--laser-x', '--laser-y')
  if (!active) return null

  return (
    <div ref={layerRef} className='laser-pointer' data-laser-pointer aria-hidden='true'>
      <span className='laser-trail' />
      <span className='laser-trail' />
      <span className='laser-trail' />
      <span className='laser-dot' />
    </div>
  )
}

export function Spotlight({ active }: { active: boolean }) {
  const layerRef = usePointerTracker(active, '--spotlight-x', '--spotlight-y')
  if (!active) return null

  return (
    <div ref={layerRef} className='presentation-spotlight' data-presentation-spotlight aria-hidden='true' />
  )
}
