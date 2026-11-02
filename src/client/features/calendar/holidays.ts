/**
 * A small, explicit holiday table.
 *
 * Lunar holidays need a real almanac and are not guessed here; the fixed-date holidays are the ones
 * a local calendar can state without pretending to know a year's official shifts. The client supplies
 * the labels so the generated calendar speaks the reader's language.
 */
import { t } from '../../lib/i18n'

export interface HolidayPreset {
  date: string
  title: string
}

function key(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function fourthThursday(year: number, month: number): number {
  const first = new Date(year, month - 1, 1)
  const offset = (4 - first.getDay() + 7) % 7
  return 1 + offset + 21
}

export function holidayPresets(locale: string, year: number): HolidayPreset[] {
  if (locale.toLowerCase().startsWith('zh')) {
    return [
      { date: key(year, 1, 1), title: t('calendar.holidays.new_year') },
      { date: key(year, 5, 1), title: t('calendar.holidays.labor_day') },
      { date: key(year, 10, 1), title: t('calendar.holidays.national_day') },
    ]
  }
  return [
    { date: key(year, 1, 1), title: t('calendar.holidays.new_year') },
    { date: key(year, 7, 4), title: t('calendar.holidays.independence') },
    { date: key(year, 11, fourthThursday(year, 11)), title: t('calendar.holidays.thanksgiving') },
    { date: key(year, 12, 25), title: t('calendar.holidays.christmas') },
  ]
}
