// The lyric stage: three ways to watch one line at a time, driven by the audio element.
//
// The pane owns its lyric read and its clock; the shell only places it. React renders a line when the
// line changes, while the clock writes the word fill and the tilt progress through CSS variables on
// the same single animation frame. Sparks are optional and exist only while a word is fresh.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from 'react'
import { Palette } from 'lucide-react'
import { isInstrumentalLyrics, lyricWordStateAt, type LyricLine } from '@shared/music/lyrics'
import { MUSIC_STAGE_STYLES, type MusicStageStyle } from '@shared/music/model'
import { Button, IconButton } from '../../../components/primitives'
import { Menu, type MenuItem } from '../../../components/overlay'
import { musicText } from '../components/labels'
import { useLyricOffset, useTrackLyrics } from '../components/LyricPanel'
import { QuietCommentLayer } from '../comments/QuietCommentLayer'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicSettings } from '../store/settings'
import { partitaRows } from './partita-layout'
import { clearStageSparks, drawStageSparks, type SparkOrigin } from './stage-sparks'
import {
  STAGE_OUTGOING_MS,
  springStep,
  stageLineProgress,
  stageSparkBursts,
  stageUnits,
  stageWordPhase,
  wordShapes,
  type StageWord,
} from './stage-math'
import { useReducedMotion, useStagePlayhead } from './stage-playhead'
import { tiltParts } from './tilt-layout'
import './stage.css'

/** Locale keys the integrator adds for the stage menu. */
export const STAGE_MENU_LABEL_KEY = 'music.stage.menu'
export const STAGE_STYLE_KEYS: Record<MusicStageStyle, string> = {
  classic: 'music.stage.style.classic',
  partita: 'music.stage.style.partita',
  tilt: 'music.stage.style.tilt',
}
export const STAGE_SPARKS_KEY = 'music.stage.sparks'

const LONG_LINE_CHARACTERS = 40

function collectSparkOrigins(host: HTMLElement | null): SparkOrigin[] {
  if (!host) return []
  const box = host.getBoundingClientRect()
  const origins: SparkOrigin[] = []
  for (const node of host.querySelectorAll<HTMLElement>('[data-spark-origin]')) {
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    origins.push({ x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2 })
  }
  return origins
}

function paintWords(
  elements: ReadonlyArray<HTMLSpanElement | null>,
  words: readonly StageWord[],
  timeMs: number,
): void {
  const state = lyricWordStateAt(words, timeMs)
  for (let index = 0; index < words.length; index += 1) {
    const element = elements[index]
    if (!element) continue
    const phase = stageWordPhase(index, state.index)
    if (element.dataset.phase !== phase) element.dataset.phase = phase
    if (index === state.index) {
      element.style.setProperty('--word-progress', `${(state.progress * 100).toFixed(1)}%`)
    }
  }
}

function StageDots({ label }: { label?: string }): ReactElement {
  return (
    <div className="music-stage__dots" data-testid="stage-dots" aria-hidden={label ? undefined : 'true'} aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  )
}

function ClassicLine({
  line,
  words,
  wordRefs,
}: {
  line: LyricLine
  words: readonly StageWord[]
  wordRefs: RefObject<Array<HTMLSpanElement | null>>
}): ReactElement {
  const shapes = useMemo(() => wordShapes(words.length, line.startTime), [line.startTime, words.length])
  return (
    <p className="music-stage__classic" data-line-start={line.startTime}>
      {words.map((word, index) => {
        const shape = shapes[index]
        const style = shape
          ? ({
              '--word-x': `${shape.x.toFixed(3)}em`,
              '--word-y': `${shape.y.toFixed(3)}em`,
              '--word-rotate': `${shape.rotate.toFixed(2)}deg`,
              '--word-scale': shape.scale.toFixed(3),
              '--word-delay': `${shape.delayMs}ms`,
            } as CSSProperties)
          : undefined
        return (
          <span
            key={`${line.startTime}-${index}`}
            ref={(node) => {
              wordRefs.current[index] = node
            }}
            className="music-stage__word"
            data-spark-origin="true"
            data-phase="waiting"
            style={style}
          >
            {word.text}
            {word.space ? ' ' : ''}
          </span>
        )
      })}
    </p>
  )
}

function PartitaLine({ line }: { line: LyricLine }): ReactElement {
  const rows = useMemo(() => partitaRows(line), [line])
  return (
    <div className="music-stage__partita">
      {rows.map((row) => (
        <span
          key={`${line.startTime}-${row.index}`}
          className="music-stage__partita-row"
          data-align={row.align}
          data-spark-origin="true"
          style={{ '--row-shift': `${row.shift}%`, '--row-delay': `${row.delayMs}ms` } as CSSProperties}
        >
          {row.text}
        </span>
      ))}
    </div>
  )
}

function TiltLine({ line }: { line: LyricLine }): ReactElement {
  const parts = useMemo(() => tiltParts(line), [line])
  return (
    <div className="music-stage__tilt">
      {parts.map((part) => (
        <span
          key={`${line.startTime}-${part.index}`}
          className="music-stage__tilt-part"
          data-accent={part.accent ? 'true' : undefined}
          data-spark-origin="true"
          style={{
            '--part-tilt': `${part.tilt.toFixed(2)}deg`,
            '--part-spacing': `${part.letterSpacingEm}em`,
            '--part-offset': `${part.offsetEm.toFixed(3)}em`,
            '--part-index': part.index,
          } as CSSProperties}
        >
          {part.characters.map((character, index) => (
            <span
              key={`${part.index}-${index}`}
              className="music-stage__tilt-char"
              style={{ '--char-index': index, '--char-count': part.characters.length } as CSSProperties}
            >
              {character}
            </span>
          ))}
        </span>
      ))}
    </div>
  )
}

export function StagePane(): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const style = useMusicSettings((state) => state.local.stageStyle)
  const sparks = useMusicSettings((state) => state.local.stageSparks)
  const showTranslation = useMusicSettings((state) => state.local.lyrics.showTranslation)
  const setLocal = useMusicSettings((state) => state.setLocal)
  const reducedMotion = useReducedMotion()
  const lyrics = useTrackLyrics(current)
  const [offset] = useLyricOffset(current)
  const playing = status === 'playing'

  const [outgoing, setOutgoing] = useState<LyricLine | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuAnchorRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wordRefs = useRef<Array<HTMLSpanElement | null>>([])
  const springRef = useRef({ value: 0, velocity: 0 })
  const frameClockRef = useRef<number | null>(null)
  const sparksPaintedRef = useRef(false)

  const currentLineRef = useRef<LyricLine | null>(null)
  const unitsRef = useRef<StageWord[]>([])

  const onFrame = useCallback((timeMs: number): void => {
    const line = currentLineRef.current
    const units = unitsRef.current
    if (line && units.length) paintWords(wordRefs.current, units, timeMs)

    const root = rootRef.current
    const target = line ? stageLineProgress(line, timeMs) : 0
    if (root) {
      if (reducedMotion) {
        root.style.setProperty('--stage-line-progress', target.toFixed(3))
      } else {
        const previous = frameClockRef.current
        const delta = previous === null ? 16 : timeMs - previous
        frameClockRef.current = timeMs
        if (delta < 0 || delta > 400) {
          springRef.current = { value: target, velocity: 0 }
        } else {
          springRef.current = springStep(springRef.current, target, delta)
        }
        const value = Math.max(0, Math.min(1, springRef.current.value))
        root.style.setProperty('--stage-line-progress', value.toFixed(3))
      }
    }

    if (!sparks || reducedMotion) return
    const canvas = canvasRef.current
    if (!canvas) return
    const bursts = stageSparkBursts(units, timeMs)
    if (bursts.length) {
      drawStageSparks(canvas, bursts, collectSparkOrigins(viewportRef.current))
      sparksPaintedRef.current = true
    } else if (sparksPaintedRef.current) {
      clearStageSparks(canvas)
      sparksPaintedRef.current = false
    }
  }, [reducedMotion, sparks])

  const reportedIndex = useStagePlayhead({
    lines: lyrics.lines,
    fallbackTimeMs: positionMs,
    offsetMs: offset,
    playing,
    reducedMotion,
    onFrame,
  })
  const activeIndex = reportedIndex < lyrics.lines.length ? reportedIndex : -1
  const instrumental = isInstrumentalLyrics(lyrics.lines)
  const currentLine = !instrumental && activeIndex >= 0 ? lyrics.lines[activeIndex] ?? null : null

  const previousIndexRef = useRef(-1)
  const linesRef = useRef(lyrics.lines)
  linesRef.current = lyrics.lines

  useEffect(() => {
    previousIndexRef.current = -1
    setOutgoing(null)
  }, [current?.id])

  useEffect(() => {
    if (previousIndexRef.current === activeIndex) return
    const previous = previousIndexRef.current >= 0 ? linesRef.current[previousIndexRef.current] ?? null : null
    previousIndexRef.current = activeIndex
    setOutgoing(activeIndex >= 0 ? previous : null)
  }, [activeIndex, current?.id])

  useEffect(() => {
    if (!outgoing) return
    const timer = setTimeout(() => setOutgoing(null), STAGE_OUTGOING_MS + 100)
    return () => clearTimeout(timer)
  }, [outgoing])

  useEffect(() => {
    springRef.current = { value: 0, velocity: 0 }
    frameClockRef.current = null
  }, [currentLine])

  const units = useMemo(() => (currentLine ? stageUnits(currentLine) : []), [currentLine])
  const nextLine = currentLine
    ? lyrics.lines[activeIndex + 1] ?? null
    : lyrics.lines[0] ?? null
  const longLine = currentLine ? [...currentLine.fullText].length > LONG_LINE_CHARACTERS : false
  currentLineRef.current = currentLine
  unitsRef.current = units

  const styleItems: MenuItem[] = MUSIC_STAGE_STYLES.map((value) => ({
    id: `stage-style-${value}`,
    label: musicText(STAGE_STYLE_KEYS[value]),
    checked: style === value,
    onSelect: () => setLocal({ stageStyle: value }),
  }))
  const menuItems: MenuItem[] = [
    ...styleItems,
    {
      id: 'stage-sparks',
      label: musicText(STAGE_SPARKS_KEY),
      checked: sparks,
      separatorBefore: true,
      onSelect: () => setLocal({ stageSparks: !sparks }),
    },
  ]

  const showEmpty = !currentLine && lyrics.status === 'ready' && (lyrics.lines.length === 0 || instrumental)
  const showError = !currentLine && lyrics.status === 'error'

  return (
    <section
      ref={rootRef}
      className="music-stage"
      data-style={style}
      data-playing={playing ? 'true' : undefined}
      data-reduced-motion={reducedMotion ? 'true' : undefined}
      aria-label={musicText('music.stage.title')}
    >
      <div className="music-stage__toolbar">
        <IconButton
          ref={menuAnchorRef}
          label={musicText(STAGE_MENU_LABEL_KEY)}
          size="sm"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          active={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Palette size={15} />
        </IconButton>
        <Menu
          anchor={menuAnchorRef}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={menuItems}
          align="end"
          width={190}
          label={musicText(STAGE_MENU_LABEL_KEY)}
        />
      </div>

      <div className="music-stage__viewport" ref={viewportRef}>
        {outgoing && currentLine && (
          <p
            key={`outgoing-${outgoing.startTime}`}
            className="music-stage__line music-stage__line--outgoing"
            aria-hidden="true"
          >
            {outgoing.fullText}
          </p>
        )}

        {currentLine ? (
          <div
            key={`line-${currentLine.startTime}`}
            className="music-stage__line music-stage__line--current"
            data-line-start={currentLine.startTime}
            data-long={longLine ? 'true' : undefined}
          >
            {style === 'partita' ? (
              <PartitaLine line={currentLine} />
            ) : style === 'tilt' ? (
              <TiltLine line={currentLine} />
            ) : (
              <ClassicLine line={currentLine} words={units} wordRefs={wordRefs} />
            )}
          </div>
        ) : (
          <div className="music-stage__interlude">
            {showError ? (
              <>
                <p className="music-stage__hint" title={lyrics.error ?? undefined}>
                  {musicText('music.lyrics.error')}
                </p>
                <Button size="sm" variant="ghost" onClick={lyrics.retry}>
                  {musicText('music.lyrics.retry')}
                </Button>
              </>
            ) : showEmpty ? (
              <p className="music-stage__hint">{musicText('music.lyrics.empty')}</p>
            ) : (
              <StageDots />
            )}
          </div>
        )}

        {sparks && !reducedMotion && (
          <canvas ref={canvasRef} className="music-stage__sparks" aria-hidden="true" />
        )}
      </div>

      <footer className="music-stage__footer" data-empty={!nextLine && !currentLine?.translation ? 'true' : undefined}>
        {showTranslation && currentLine?.translation && (
          <p className="music-stage__translation">{currentLine.translation}</p>
        )}
        {nextLine && <p className="music-stage__next">{nextLine.fullText}</p>}
      </footer>

      <QuietCommentLayer lines={lyrics.lines} loaded={lyrics.status !== 'loading'} className="music-stage__quiet" />
    </section>
  )
}
