import type { AccentName, AppLocale, BackgroundName, ProseFont, ProseWidth, ThemePref, UiDensity } from '@shared/types'
import { useMemo } from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Segmented, SettingRow, Slider, Switch } from '../../components/form'
import { Tooltip } from '../../components/overlay'
import { YearGrid, type YearGridMonth } from '../../components/calendar-grids'
import { buildYearHeatMeta, heatCell, yearHeatLevel } from '../../components/activity-calendar'
import { buildActivityProjectionCached } from '../../lib/calendar-activity'
import { setYearGridColumns, useYearGridColumns, type YearGridColumnsPref } from '../../lib/year-grid-prefs'
import { setCalendarDisplayPrefs, useCalendarDisplayPrefs, WEEK_START_PREFS, type CalendarToggle, type WeekStartPref } from '../../lib/calendar-display-prefs'
import { narrowWeekdayLabels, weekStartFor } from '../../lib/time'
import { useNotes } from '../../store/notes'
import { switchThemeWithTransition, useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { t, useLocale, type MessageKey } from '../../lib/i18n'

const ACCENT_MESSAGE_KEYS: Record<AccentName, MessageKey> = {
  cinnabar: 'settings.accent.cinnabar',
  indigo: 'settings.accent.indigo',
  celadon: 'settings.accent.celadon',
  amber: 'settings.accent.amber',
  terracotta: 'settings.accent.terracotta',
  wisteria: 'settings.accent.wisteria',
  graphite: 'settings.accent.graphite',
}

export function AppearanceSettings({
  accents,
}: {
  accents: { name: AccentName; swatch: string; foreground: string }[]
}) {
  const appearance = useSession((s) => s.settings.appearance)
  const update = useSession((s) => s.updateSettings)
  const locale = useLocale()
  const yearGridColumns = useYearGridColumns()

  return (
    <div>
      <section>
        <SettingRow title={t("settings.interface_language")}>
          <Segmented<AppLocale>
            label={t("settings.interface_language")}
            value={appearance.language}
            onChange={(language) => void update({ appearance: { language } })}
            options={[
              { value: 'zh-CN', label: t("settings.simplified_chinese") },
              { value: 'en-US', label: t("settings.english") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("settings.theme")}>
          <Segmented<ThemePref>
            label={t("settings.theme")}
            value={appearance.theme}
            onChange={(theme) => {
              switchThemeWithTransition(theme, undefined, () => update({ appearance: { theme } }))
            }}
            options={[
              { value: 'light', label: <Sun size={12.5} />, title: t("settings.light") },
              { value: 'dark', label: <Moon size={12.5} />, title: t("settings.dark") },
              { value: 'system', label: <Monitor size={12.5} />, title: t("settings.system") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("settings.accent_color")}>
          <div role="group" aria-label={t("settings.accent_color")} className="flex items-center gap-1.5">
            {accents.map((accent) => (
              <Tooltip key={accent.name} label={t(ACCENT_MESSAGE_KEYS[accent.name])}>
                <button
                  type="button"
                  onClick={() => void update({ appearance: { accent: accent.name } })}
                  aria-label={t(ACCENT_MESSAGE_KEYS[accent.name])}
                  aria-pressed={appearance.accent === accent.name}
                  className={cn(
                    'relative flex size-6 items-center justify-center rounded-full transition-transform duration-[var(--dur-fast)] ease-[var(--ease-spring)]',
                    'hover:scale-110 active:scale-95',
                    appearance.accent === accent.name && 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-overlay)]',
                  )}
                  style={{ background: accent.swatch, color: accent.foreground }}
                >
                  {appearance.accent === accent.name && (
                    <Check size={12} strokeWidth={3} className="drop-shadow-sm" />
                  )}
                </button>
              </Tooltip>
            ))}
          </div>
        </SettingRow>

        <SettingRow title={t("settings.background_color")}>
          <div role="group" aria-label={t("settings.background_color")} className="flex items-center gap-2">
            {([
              { name: 'paper', label: t("settings.background_paper"), swatch: '#f7f5f1' },
              { name: 'white', label: t("settings.background_white"), swatch: '#ffffff' },
            ] satisfies { name: BackgroundName; label: string; swatch: string }[]).map((background) => (
              <button
                key={background.name}
                type="button"
                onClick={() => void update({ appearance: { background: background.name } })}
                aria-pressed={appearance.background === background.name}
                className={cn(
                  'flex h-8 min-w-[84px] items-center gap-2 rounded-[var(--r-md)] border px-2.5 text-[11.5px] transition-[border-color,background-color,box-shadow] duration-[var(--dur-fast)]',
                  appearance.background === background.name
                    ? 'border-[var(--accent)] bg-[var(--accent-softer)] shadow-[0_0_0_2px_var(--accent-ring)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-base)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <span
                  aria-hidden="true"
                  className="size-4 rounded-full border border-black/10 shadow-sm"
                  style={{ background: background.swatch }}
                />
                <span>{background.label}</span>
                {appearance.background === background.name && <Check size={11} className="ml-auto text-[var(--accent)]" />}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow title={t("settings.interface_density")}>
          <Segmented<UiDensity>
            label={t("settings.interface_density")}
            value={appearance.density}
            onChange={(density) => void update({ appearance: { density } })}
            options={[
              { value: 'comfortable', label: t("settings.comfortable") },
              { value: 'compact', label: t("settings.compact") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("settings.year_grid_columns")} description={t("settings.year_grid_columns_desc")}>
          <Segmented<YearGridColumnsPref>
            label={t("settings.year_grid_columns")}
            value={yearGridColumns}
            onChange={setYearGridColumns}
            options={[
              { value: 'auto', label: t("settings.year_grid_columns_auto") },
              { value: '3', label: t("settings.year_grid_columns_three") },
              { value: '4', label: t("settings.year_grid_columns_four") },
            ]}
          />
        </SettingRow>

        <YearGridPreview columns={yearGridColumns} locale={locale}/>
      </section>

      <CalendarDisplaySettings locale={locale}/>

      <section>
        <h3 data-setting-title={t("settings.preview_typography")} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {t("settings.preview_typography")}
        </h3>

        <SettingRow title={t("settings.body_font")}>
          <Segmented<ProseFont>
            label={t("settings.body_font")}
            value={appearance.proseFont}
            onChange={(proseFont) => void update({ appearance: { proseFont } })}
            options={[
              { value: 'sans', label: t("common.sans_serif") },
              { value: 'serif', label: t("settings.serif") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("settings.body_text_size")}>
          <Slider
            label={t("settings.body_text_size")}
            className="w-[200px]"
            value={appearance.proseSize}
            min={13}
            max={22}
            onChange={(proseSize) => void update({ appearance: { proseSize } })}
            suffix="px"
          />
        </SettingRow>

        <SettingRow title={t("settings.line_height")}>
          <Slider
            label={t("settings.line_height")}
            className="w-[200px]"
            value={appearance.proseLineHeight}
            min={1.4}
            max={2.2}
            step={0.05}
            onChange={(proseLineHeight) => void update({ appearance: { proseLineHeight } })}
          />
        </SettingRow>

        <SettingRow title={t("settings.content_width")}>
          <Segmented<ProseWidth>
            label={t("settings.content_width")}
            value={appearance.proseWidth}
            onChange={(proseWidth) => void update({ appearance: { proseWidth } })}
            options={[
              { value: 'narrow', label: t("settings.narrow") },
              { value: 'normal', label: t("settings.standard") },
              { value: 'wide', label: t("settings.wide") },
              { value: 'full', label: t("settings.full") },
            ]}
          />
        </SettingRow>
      </section>

      <PreviewSample />
    </div>
  )
}


function PreviewSample() {
  const appearance = useSession((s) => s.settings.appearance)
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {t("settings.preview")}
      </h3>
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3">
        <div
          className="ink-prose"
          data-font={appearance.proseFont}
          style={{ maxWidth: 'none', paddingBlock: 0 }}
        >
          <h3 style={{ marginTop: 0 }}>{t("settings.q_a_in_the_mountains")}</h3>
          <p>
            {t("settings.asked_why_i_wanted_to_live_in_the_green_mountains_i_smiled_without_answe")}{' '}
            {t("settings.chinese_english_and")} <code>{t("common.inline_code")}</code> {t("settings.look_at_home_together")}
          </p>
        </div>
      </div>
    </section>
  )
}

function PreviewMonthCard({ month, label, counts, yearMax, onJump }: {
  month: YearGridMonth
  label: string
  counts: ReadonlyMap<string, number>
  yearMax: number
  onJump: (month: number) => void
}) {
  return (
    <button
      type="button"
      aria-label={t('settings.year_grid_columns_jump_value0', { value0: label })}
      onClick={() => { onJump(month.month) }}
      className="flex min-w-0 flex-col items-center gap-0.5 rounded-[var(--r-3)] p-px transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
    >
      <span className="text-[length:var(--text-12)] font-medium text-[var(--text-quaternary)]">{label}</span>
      <span aria-hidden="true" className="grid w-full grid-cols-7 gap-px">
        {month.cells.map((cell) => (
          <span
            key={cell.key}
            className={cn('aspect-square w-full rounded-[var(--r-1)]', cell.today && 'ring-1 ring-inset ring-[var(--accent)]')}
            style={heatCell(cell.inMonth ? yearHeatLevel(counts, yearMax, cell.key) : null)}
          />
        ))}
      </span>
    </button>
  )
}

function YearGridPreview({ columns, locale }: { columns: YearGridColumnsPref; locale: string }) {
  const notes = useNotes((s) => s.notes)
  const previewYear = new Date().getFullYear()
  const monthLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { month: 'short' })
    return Array.from({ length: 12 }, (_, month) => formatter.format(new Date(previewYear, month, 1)))
  }, [locale, previewYear])
  const weekStart = weekStartFor(locale)
  const { counts } = useMemo(() => buildActivityProjectionCached(notes), [notes])
  const { yearMax } = useMemo(() => buildYearHeatMeta(counts, previewYear), [counts, previewYear])
  const jumpToMonth = (month: number) => {
    useUi.getState().requestCalendarJump(previewYear, month)
    useUi.getState().closePanel()
  }
  return (
    <div className="mt-1 mb-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[length:var(--text-9-5)] font-medium text-[var(--text-quaternary)]">{t('settings.year_grid_columns_preview')}</span>
        <span className="text-[length:var(--text-9-5)] text-[var(--text-quaternary)]">{t('settings.year_grid_columns_preview_tip')}</span>
      </div>
      <YearGrid
        year={previewYear}
        weekStart={weekStart}
        columns={columns === '4' ? 4 : 3}
        renderMonth={(month) => (<PreviewMonthCard key={month.month} month={month} label={monthLabels[month.month] ?? ''} counts={counts} yearMax={yearMax} onJump={jumpToMonth}/>)}
      />
    </div>
  )
}

const TOGGLE_VALUES: CalendarToggle[] = ['auto', 'on', 'off']

/**
 * The sidebar calendar's own switches, kept in Appearance because every one of them changes what the
 * heat grid paints and nothing else. They live in local storage beside the year-grid column count,
 * so a reader's almanac preference travels with the device they read it on.
 */
export function CalendarDisplaySettings({ locale }: { locale: string }) {
  const prefs = useCalendarDisplayPrefs()
  const dayLabels = useMemo(() => narrowWeekdayLabels(locale, 0), [locale])
  return (
    <section>
      <h3 data-setting-title={t('settings.calendar_display')} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {t('settings.calendar_display')}
      </h3>

      <SettingRow title={t("settings.calendar_lunar")} description={t("settings.calendar_lunar_desc")}>
        <Segmented<CalendarToggle>
          label={t("settings.calendar_lunar")}
          size="sm"
          value={prefs.lunarLabels}
          onChange={(lunarLabels) => setCalendarDisplayPrefs({ lunarLabels })}
          options={TOGGLE_VALUES.map((value) => ({
            value,
            label: t(value === 'auto' ? "settings.calendar_toggle_auto" : value === 'on' ? "settings.calendar_toggle_on" : "settings.calendar_toggle_off"),
          }))}
        />
      </SettingRow>

      <SettingRow title={t("settings.calendar_festivals")} description={t("settings.calendar_festivals_desc")}>
        <Segmented<CalendarToggle>
          label={t("settings.calendar_festivals")}
          size="sm"
          value={prefs.festivals}
          onChange={(festivals) => setCalendarDisplayPrefs({ festivals })}
          options={TOGGLE_VALUES.map((value) => ({
            value,
            label: t(value === 'auto' ? "settings.calendar_toggle_auto" : value === 'on' ? "settings.calendar_toggle_on" : "settings.calendar_toggle_off"),
          }))}
        />
      </SettingRow>

      <SettingRow title={t("settings.calendar_week_start")} description={t("settings.calendar_week_start_desc")}>
        <Segmented<WeekStartPref>
          label={t("settings.calendar_week_start")}
          size="sm"
          value={prefs.weekStart}
          onChange={(weekStart) => setCalendarDisplayPrefs({ weekStart })}
          options={WEEK_START_PREFS.map((value) => ({ value, label: value === 'auto' ? t("settings.calendar_toggle_auto") : dayLabels[Number(value)] ?? value }))}
        />
      </SettingRow>

      <SettingRow title={t("settings.calendar_week_numbers")} description={t("settings.calendar_week_numbers_desc")}>
        <Switch checked={prefs.weekNumbers} onChange={(weekNumbers) => setCalendarDisplayPrefs({ weekNumbers })} label={t("settings.calendar_week_numbers")}/>
      </SettingRow>

      <SettingRow title={t("settings.calendar_today_card")} description={t("settings.calendar_today_card_desc")}>
        <Switch checked={prefs.todayCard} onChange={(todayCard) => setCalendarDisplayPrefs({ todayCard })} label={t("settings.calendar_today_card")}/>
      </SettingRow>

      <SettingRow title={t("settings.calendar_streak")} description={t("settings.calendar_streak_desc")}>
        <Switch checked={prefs.streakStats} onChange={(streakStats) => setCalendarDisplayPrefs({ streakStats })} label={t("settings.calendar_streak")}/>
      </SettingRow>

      <SettingRow title={t("settings.calendar_weekend")} description={t("settings.calendar_weekend_desc")}>
        <Switch checked={prefs.weekendTint} onChange={(weekendTint) => setCalendarDisplayPrefs({ weekendTint })} label={t("settings.calendar_weekend")}/>
      </SettingRow>

      <SettingRow title={t("settings.calendar_adjacent")} description={t("settings.calendar_adjacent_desc")}>
        <Switch checked={prefs.showAdjacentDays} onChange={(showAdjacentDays) => setCalendarDisplayPrefs({ showAdjacentDays })} label={t("settings.calendar_adjacent")}/>
      </SettingRow>
    </section>
  )
}
