const DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_VALUE = /^([01]\d|2[0-3]):([0-5]\d)$/

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

export function memoDateValue(seconds: number): string {
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function memoTimeValue(seconds: number): string {
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return ''
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function memoLocalTimestamp(date: string, time: string): number | null {
  const dateMatch = DATE_VALUE.exec(date)
  const timeMatch = TIME_VALUE.exec(time)
  if (!dateMatch || !timeMatch) return null
  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const value = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (
    value.getFullYear() !== year
    || value.getMonth() !== month - 1
    || value.getDate() !== day
    || value.getHours() !== hour
    || value.getMinutes() !== minute
  ) return null
  return Math.floor(value.getTime() / 1000)
}
