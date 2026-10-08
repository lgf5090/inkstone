/**
 * The lint engine's own log channel.
 *
 * A lint run touches every rule in the library, so the debug stream is the only way a reader can
 * tell which rule changed what. Nothing is written unless a run asks for it: `setCollectLogs(true)`
 * keeps the lines for the results dialog, and `setLogLevel` decides whether they also reach the
 * console. Timings are kept per key so nested phases (pre-rules, one rule, post-rules) add up
 * without a profiler.
 */
export enum LogLevels {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  Silent = 5,
}

let currentLevel = LogLevels.Info;
let collectEnabled = false;

export const logsFromLastRun: string[] = [];

function record(message: string, level: LogLevels): void {
  if (collectEnabled && level >= currentLevel) {
    logsFromLastRun.push(message);
  }

  if (level < currentLevel || currentLevel === LogLevels.Silent) {
    return;
  }

  switch (level) {
    case LogLevels.Trace:
    case LogLevels.Debug:
      console.debug(message);
      break;
    case LogLevels.Info:
      console.info(message);
      break;
    case LogLevels.Warn:
      console.warn(message);
      break;
    default:
      console.error(message);
  }
}

export function logTrace(message: string): void {
  record(message, LogLevels.Trace);
}

export function logDebug(message: string): void {
  record(message, LogLevels.Debug);
}

export function logInfo(message: string): void {
  record(message, LogLevels.Info);
}

export function logWarn(message: string): void {
  record(message, LogLevels.Warn);
}

export function logError(labelForError: string, error: Error): void {
  const message = `${labelForError}: ${error.message}`;
  record(message, LogLevels.Error);
  if (collectEnabled) {
    logsFromLastRun.push(`${message}\n${error.stack ?? ''}`);
  }
}

const openTimings = new Map<string, number>()
const timings = new Map<string, number>()

export function timingBegin(timingKey: string): void {
  if (currentLevel > LogLevels.Debug) {
    return;
  }

  const prefix = `${' '.repeat(Math.min(4, openTimings.size))}`;
  openTimings.set(timingKey, performance.now());
  record(`${prefix}${timingKey} started`, LogLevels.Debug);
}

export function timingEnd(timingKey: string): void {
  const startedAt = openTimings.get(timingKey);
  if (startedAt === undefined) {
    return;
  }

  openTimings.delete(timingKey);
  const elapsed = performance.now() - startedAt;
  timings.set(timingKey, (timings.get(timingKey) ?? 0) + elapsed);
  if (currentLevel <= LogLevels.Debug) {
    record(`${timingKey} took ${elapsed.toFixed(2)} ms`, LogLevels.Debug);
  }
}

export function getTimings(): ReadonlyMap<string, number> {
  return timings;
}

export function clearLogs(): void {
  logsFromLastRun.length = 0;
  openTimings.clear();
  timings.clear();
}

export function setCollectLogs(enabled: boolean): void {
  collectEnabled = enabled;
  if (enabled) {
    logsFromLastRun.length = 0;
  }
}

export function isCollectingLogs(): boolean {
  return collectEnabled;
}

export function setLogLevel(logLevel: number | string): void {
  const asNumber = typeof logLevel === 'number' ? logLevel : Number(logLevel);
  currentLevel = Number.isNaN(asNumber) ? levelForName(String(logLevel)) : clampLevel(asNumber);
}

function levelForName(name: string): LogLevels {
  const match = Object.values(LogLevels).find((level) => typeof level === 'number' && LogLevels[level].toLowerCase() === name.toLowerCase());
  return match === undefined ? LogLevels.Info : (match as LogLevels);
}

function clampLevel(value: number): LogLevels {
  return Math.max(LogLevels.Trace, Math.min(LogLevels.Silent, Math.trunc(value))) as LogLevels;
}

export function convertNumberToLogLevel(logLevel: number): string {
  return LogLevels[clampLevel(logLevel)];
}
