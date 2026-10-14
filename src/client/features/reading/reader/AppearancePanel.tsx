/**
 * The appearance panel: the same settings as the app's own appearance section, reached from inside a
 * book because that is where a reader notices the type is wrong.
 *
 * Every control writes through to the store immediately and the page re-lays out live — a setting that
 * only applied on close would have to be imagined rather than tried.
 */
import { useRef } from 'react'
import { Upload } from 'lucide-react'
import { Button, SectionLabel } from '../../../components/primitives'
import { Segmented, Select, Slider, Switch } from '../../../components/form'
import { Tooltip } from '../../../components/overlay'
import { t, type MessageKey } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import {
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  MARGIN_RANGE,
  useReaderSettings,
  type ReaderSettings,
} from '../store/reader-settings'
import { READER_THEMES, READER_THEME_ORDER, type ReaderThemeName } from '../themes'
import { HIGHLIGHT_COLORS } from '../types'
import { DEFAULT_HIGHLIGHT_PAINT } from '../themes'

export function AppearancePanel() {
  const settings = useReaderSettings()
  const update = useReaderSettings((state) => state.update)
  const importFont = useReaderSettings((state) => state.importFont)
  const fileInput = useRef<HTMLInputElement>(null)
  const toast = useUi((state) => state.toast)
  const set = <Key extends keyof ReaderSettings,>(key: Key, value: ReaderSettings[Key]) => update(key, value)

  return (
    <div className="px-3 pb-4">
      <SectionLabel className="px-0">{t('reading.theme')}</SectionLabel>
      <div className="flex flex-wrap gap-1.5 py-2">
        <ThemeSwatch name="auto" label={t('reading.theme_auto')} current={settings.theme} onPick={set} />
        {READER_THEME_ORDER.map((name) => (
          <ThemeSwatch key={name} name={name} label={t(THEME_KEYS[name])} current={settings.theme} onPick={set} />
        ))}
      </div>

      <Slider label={t('reading.font_size')} value={settings.fontSize} min={FONT_SIZE_RANGE.min} max={FONT_SIZE_RANGE.max} step={FONT_SIZE_RANGE.step} onChange={(value) => set('fontSize', value)} suffix="px" />
      <Slider label={t('reading.line_height')} value={settings.lineHeight} min={LINE_HEIGHT_RANGE.min} max={LINE_HEIGHT_RANGE.max} step={LINE_HEIGHT_RANGE.step} onChange={(value) => set('lineHeight', value)} />
      <Slider label={t('reading.letter_spacing')} value={settings.letterSpacing} min={0} max={0.16} step={0.01} onChange={(value) => set('letterSpacing', value)} />
      <Slider label={t('reading.paragraph_spacing')} value={settings.paragraphSpacing} min={0} max={2.4} step={0.1} onChange={(value) => set('paragraphSpacing', value)} />
      <Slider label={t('reading.page_margin')} value={settings.margin} min={MARGIN_RANGE.min} max={MARGIN_RANGE.max} step={MARGIN_RANGE.step} onChange={(value) => set('margin', value)} suffix="px" />

      <SectionLabel className="px-0 pt-3">{t('reading.typeface')}</SectionLabel>
      <Segmented
        value={settings.fontFamily}
        onChange={(value) => set('fontFamily', value)}
        options={[
          { value: 'serif', label: t('reading.font_serif') },
          { value: 'sans', label: t('reading.font_sans') },
          { value: 'mono', label: t('reading.font_mono') },
          { value: 'custom', label: t('reading.font_custom') },
        ]}
      />
      {settings.importedFonts.length ? (
        <Select
          value={settings.customFamily}
          onChange={(event) => set('customFamily', event.target.value)}
          className="mt-2 h-8 w-full text-[length:var(--text-12)]"
          aria-label={t('reading.pick_imported_font')}
        >
          <option value="">{t('reading.font_none')}</option>
          {settings.importedFonts.map((font) => (
            <option key={font.id} value={font.family}>{font.label}</option>
          ))}
        </Select>
      ) : null}
      <Button
        size="sm"
        className="mt-2 h-8 text-[length:var(--text-12)]"
        icon={<Upload size={13} />}
        onClick={() => fileInput.current?.click()}
      >
        {t('reading.import_font')}
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          void importFont(file).then((font) => {
            set('fontFamily', 'custom')
            set('customFamily', font.family)
            toast({ title: t('reading.font_imported'), tone: 'success' })
          }, (err: unknown) => {
            toast({ title: t('reading.font_import_failed'), description: err instanceof Error ? err.message : String(err), tone: 'danger' })
          })
        }}
      />

      <SectionLabel className="px-0 pt-3">{t('reading.layout')}</SectionLabel>
      <Segmented
        value={settings.readMode}
        onChange={(value) => set('readMode', value)}
        options={[
          { value: 'paged', label: t('reading.mode_paged') },
          { value: 'scroll', label: t('reading.mode_scroll') },
        ]}
      />
      <div className="mt-2">
        <Segmented
          value={settings.columns === 2 ? 'two' : 'one'}
          onChange={(value) => set('columns', value === 'two' ? 2 : 1)}
          options={[
            { value: 'one', label: t('reading.columns_one') },
            { value: 'two', label: t('reading.columns_two') },
          ]}
        />
      </div>
      <Row label={t('reading.text_align')}>
        <Segmented
          size="sm"
          value={settings.textAlign}
          onChange={(value) => set('textAlign', value)}
          options={[
            { value: 'left', label: t('reading.align_left') },
            { value: 'justify', label: t('reading.align_justify') },
          ]}
        />
      </Row>
      <Row label={t('reading.first_line_indent')}>
        <Switch checked={settings.firstLineIndent} onChange={(value) => set('firstLineIndent', value)} label={t('reading.first_line_indent')} />
      </Row>
      <Row label={t('reading.hyphenation')}>
        <Switch checked={settings.hyphenate} onChange={(value) => set('hyphenate', value)} label={t('reading.hyphenation')} />
      </Row>
      <Row label={t('reading.show_figures')}>
        <Switch checked={settings.showFigures} onChange={(value) => set('showFigures', value)} label={t('reading.show_figures')} />
      </Row>
      <Row label={t('reading.focus_paragraph')}>
        <Switch checked={settings.focusParagraph} onChange={(value) => set('focusParagraph', value)} label={t('reading.focus_paragraph')} />
      </Row>
      <Row label={t('reading.page_turn_animation')}>
        <Switch checked={settings.pageTurnAnimation} onChange={(value) => set('pageTurnAnimation', value)} label={t('reading.page_turn_animation')} />
      </Row>
      <Row label={t('reading.immersive_chrome')}>
        <Switch checked={settings.immersive} onChange={(value) => set('immersive', value)} label={t('reading.immersive_chrome')} />
      </Row>
      <Row label={t('reading.page_buttons_hover')}>
        <Segmented
          size="sm"
          value={settings.pageButtons}
          onChange={(value) => set('pageButtons', value)}
          options={[
            { value: 'always', label: t('reading.page_buttons_always') },
            { value: 'hover', label: t('reading.page_buttons_hover_short') },
          ]}
        />
      </Row>

      <SectionLabel className="px-0 pt-3">{t('reading.gestures')}</SectionLabel>
      <Row label={t('reading.tap_zones')}>
        <Segmented
          size="sm"
          value={settings.tapZones}
          onChange={(value) => set('tapZones', value)}
          options={[
            { value: 'thirds', label: t('reading.tap_zones_thirds') },
            { value: 'edges', label: t('reading.tap_zones_edges') },
            { value: 'off', label: t('reading.tap_zones_off') },
          ]}
        />
      </Row>
      <Row label={t('reading.swipe_turns')}>
        <Switch checked={settings.swipeTurns} onChange={(value) => set('swipeTurns', value)} label={t('reading.swipe_turns')} />
      </Row>
      <Row label={t('reading.show_scrubber')}>
        <Switch checked={settings.showScrubber} onChange={(value) => set('showScrubber', value)} label={t('reading.show_scrubber')} />
      </Row>
      <Row label={t('reading.estimate_time_left')}>
        <Switch checked={settings.estimateTimeLeft} onChange={(value) => set('estimateTimeLeft', value)} label={t('reading.estimate_time_left')} />
      </Row>
      <Slider label={t('reading.dimming')} value={settings.dimming} min={0} max={0.7} step={0.05} onChange={(value) => set('dimming', value)} />
      {/* Auto-scroll is a property of a flowing page; a paginated one has nothing to scroll. */}
      {settings.readMode === 'scroll' ? (
        <Slider
          label={t('reading.auto_scroll')}
          value={settings.autoScrollSpeed}
          min={0}
          max={120}
          step={10}
          onChange={(value) => set('autoScrollSpeed', value)}
          suffix={settings.autoScrollSpeed ? ' px/s' : ''}
        />
      ) : null}

      <SectionLabel className="px-0 pt-3">{t('reading.marking')}</SectionLabel>
      <div className="flex flex-wrap gap-2 py-2">
        {HIGHLIGHT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={t(HIGHLIGHT_KEYS[color])}
            aria-pressed={settings.defaultHighlightColor === color}
            onClick={() => set('defaultHighlightColor', color)}
            className="size-6 rounded-full border-2"
            style={{
              background: DEFAULT_HIGHLIGHT_PAINT[color],
              borderColor: settings.defaultHighlightColor === color ? 'var(--accent)' : 'transparent',
            }}
          />
        ))}
      </div>
      <Row label={t('reading.selection_labels')}>
        <Switch checked={settings.selectionLabels} onChange={(value) => set('selectionLabels', value)} label={t('reading.selection_labels')} />
      </Row>
      <Row label={t('reading.auto_book_note')}>
        <Switch checked={settings.autoBookNote} onChange={(value) => set('autoBookNote', value)} label={t('reading.auto_book_note')} />
      </Row>
      <Row label={t('reading.timer_enabled')}>
        <Switch checked={settings.timerEnabled} onChange={(value) => set('timerEnabled', value)} label={t('reading.timer_enabled')} />
      </Row>
      {settings.timerEnabled ? (
        <Slider label={t('reading.daily_goal')} value={settings.dailyGoalMinutes} min={0} max={180} step={5} onChange={(value) => set('dailyGoalMinutes', value)} />
      ) : null}
      <Row label={t('reading.translate_enabled')}>
        <Switch checked={settings.translateEnabled} onChange={(value) => set('translateEnabled', value)} label={t('reading.translate_enabled')} />
      </Row>
      {settings.translateEnabled ? (
        <>
          <Segmented
            value={settings.translateEngine}
            onChange={(value) => set('translateEngine', value)}
            options={[
              { value: 'google', label: t('reading.engine_free') },
              { value: 'ai', label: t('reading.engine_ai') },
            ]}
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[length:var(--text-12)]">{t('reading.translate_to')}</span>
            <Select
              value={settings.translateTo}
              onChange={(event) => set('translateTo', event.target.value)}
              className="h-8 flex-1 text-[length:var(--text-12)]"
              aria-label={t('reading.translate_to')}
            >
              {TARGET_LANGUAGES.map((one) => (
                <option key={one.code} value={one.code}>{one.label}</option>
              ))}
            </Select>
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * A theme as the reader will meet it: the page colour with a few lines of ink on it. A swatch that showed
 * only the background could not be told apart from its neighbours, which is what the three rules are for.
 */
function ThemeSwatch({ name, label, current, onPick }: {
  name: ReaderThemeName
  label: string
  current: ReaderThemeName
  onPick: <Key extends keyof ReaderSettings,>(key: Key, value: ReaderSettings[Key]) => void
}) {
  const page = name === 'auto' ? READER_THEMES.paper : READER_THEMES[name]
  return (
    <Tooltip label={label} side="top">
    <button
      type="button"
      aria-label={label}
      aria-pressed={current === name}
      onClick={() => onPick('theme', name)}
      className="relative h-9 w-12 overflow-hidden rounded-[var(--r-sm)] border-2"
      style={{
        background: name === 'auto' ? `linear-gradient(135deg, ${READER_THEMES.paper.background} 48%, ${READER_THEMES.night.background} 52%)` : page.background,
        borderColor: current === name ? 'var(--accent)' : 'color-mix(in oklab, currentColor 18%, transparent)',
      }}
    >
      <span className="absolute inset-x-1.5 top-2 block h-px" style={{ background: name === 'auto' ? page.foreground : page.foreground, opacity: 0.5 }} />
      <span className="absolute inset-x-1.5 top-[15px] block h-px" style={{ background: page.foreground, opacity: 0.35 }} />
      <span className="absolute inset-x-1.5 top-[22px] block h-px" style={{ background: page.foreground, opacity: 0.22 }} />
    </button>
    </Tooltip>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 py-1">
      <span className="min-w-0 text-[length:var(--text-12)]">{label}</span>
      <span className="shrink-0">{children}</span>
    </div>
  )
}

const TARGET_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
]

const HIGHLIGHT_KEYS: Record<(typeof HIGHLIGHT_COLORS)[number], MessageKey> = {
  yellow: 'reading.color_yellow',
  green: 'reading.color_green',
  blue: 'reading.color_blue',
  pink: 'reading.color_pink',
  red: 'reading.color_red',
  purple: 'reading.color_purple',
}

const THEME_KEYS: Record<Exclude<ReaderThemeName, 'auto'>, MessageKey> = {
  paper: 'reading.theme_paper',
  warm: 'reading.theme_warm',
  celadon: 'reading.theme_celadon',
  moon: 'reading.theme_moon',
  xuan: 'reading.theme_xuan',
  fog: 'reading.theme_fog',
  night: 'reading.theme_night',
  ink: 'reading.theme_ink',
  eink: 'reading.theme_eink',
}
