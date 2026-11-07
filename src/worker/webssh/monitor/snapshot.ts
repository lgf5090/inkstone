import type {
  WebsshMonitorContainer,
  WebsshMonitorContainers,
  WebsshMonitorDisk,
  WebsshMonitorMemory,
  WebsshMonitorNetwork,
  WebsshMonitorNetworkInterface,
  WebsshMonitorProcess,
  WebsshMonitorProcesses,
  WebsshMonitorResources,
  WebsshMonitorSnapshot,
} from '@shared/webssh/types'

/**
 * One read-only sample in a single exec request. Every section falls back where a host has no
 * `/proc`: `sysctl` covers FreeBSD/macOS CPU, load, memory and boot time, `netstat -ibn` covers
 * their interface counters, and `ps aux` is the shared process source. The string stays on one
 * line because `buildExecRequest` refuses CR/LF, and it never interpolates user input.
 */
export const WEBSSH_MONITOR_COMMAND = [
  "echo '@@OS'",
  'uname -s 2>/dev/null',
  'uname -r 2>/dev/null',
  'uname -m 2>/dev/null',
  'uname -n 2>/dev/null',
  'cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || freebsd-version 2>/dev/null',
  "echo '@@UPTIME'",
  'cat /proc/uptime 2>/dev/null || sysctl -n kern.boottime 2>/dev/null',
  "echo '@@LOAD'",
  'cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null',
  "echo '@@CPU'",
  'head -n 1 /proc/stat 2>/dev/null || sysctl -n kern.cp_time 2>/dev/null',
  "echo '@@MEM'",
  "grep -E 'MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree' /proc/meminfo 2>/dev/null || sysctl -n hw.physmem hw.pagesize vm.stats.vm.v_free_count vm.stats.vm.v_inactive_count vm.stats.vm.v_active_count vm.stats.vm.v_wire_count vm.stats.vm.v_cache_count vm.swap_total 2>/dev/null",
  "echo '@@DISK'",
  'df -Pk 2>/dev/null | head -n 12',
  "echo '@@NET'",
  'cat /proc/net/dev 2>/dev/null || netstat -ibn 2>/dev/null | head -n 40',
  "echo '@@PS'",
  'ps ax 2>/dev/null | wc -l',
  'ps aux 2>/dev/null | sort -k3 -nr 2>/dev/null | head -n 60',
  "echo '@@PSMEM'",
  'ps aux 2>/dev/null | sort -k4 -nr 2>/dev/null | head -n 40',
  "echo '@@DOCKER'",
  "if command -v docker >/dev/null 2>&1; then echo '@@DOCKER_OK'; docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}' 2>/dev/null | head -n 50; echo '@@DSTATS'; docker stats --no-stream --format '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}' 2>/dev/null | head -n 50; fi",
  "echo '@@END'",
].join('; ')

const MARKERS = new Set([
  'OS', 'UPTIME', 'LOAD', 'CPU', 'MEM', 'DISK', 'NET', 'PS', 'PSMEM', 'DOCKER', 'DOCKER_OK', 'DSTATS', 'END',
])

const PROCESS_LIMIT = 10
const INTERFACE_LIMIT = 12

export interface MonitorCounters {
  cpu: { busy: number; total: number } | null
  network: Map<string, { rx: number; tx: number }>
  at: number
}

export interface ParsedMonitor {
  resources: WebsshMonitorResources
  network: WebsshMonitorNetwork
  processes: WebsshMonitorProcesses
  containers: WebsshMonitorContainers
  truncated: boolean
  counters: MonitorCounters
}

/** Splits the marker-delimited exec output into named blocks; unknown text is ignored. */
export function splitMonitorSections(output: string): Map<string, string[]> {
  const sections = new Map<string, string[]>()
  let current = ''
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    const marker = line.startsWith('@@') ? line.slice(2) : ''
    if (marker && MARKERS.has(marker)) {
      current = marker
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (!current) continue
    const lines = sections.get(current)
    if (lines) lines.push(line)
  }
  return sections
}

function cleanLines(lines: string[] | undefined): string[] {
  return (lines ?? []).map((line) => line.trim()).filter((line) => line.length > 0)
}

function firstLine(lines: string[]): string {
  return lines[0] ?? ''
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value.replace(/%$/, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function toBytesFromBlocks(value: number | null): number | null {
  return value === null ? null : value * 1024
}

function parseOs(lines: string[], bootTime: string): WebsshMonitorResources['os'] {
  const [system = '', release = '', arch = '', hostname = ''] = lines
  let pretty = ''
  const keyValues = new Map<string, string>()
  for (const line of lines.slice(4)) {
    const match = /^(\w+)=(.*)$/.exec(line)
    if (match) keyValues.set(match[1], match[2].replace(/^["']|["']$/g, ''))
  }
  for (const line of bootTime.split(/\r?\n/)) {
    const match = /^(ProductName|ProductVersion):\s*(.+)$/.exec(line.trim())
    if (match) keyValues.set(match[1], match[2])
  }
  const productName = keyValues.get('ProductName')
  const productVersion = keyValues.get('ProductVersion')
  if (productName) pretty = [productName, productVersion].filter(Boolean).join(' ')
  if (!pretty) pretty = keyValues.get('PRETTY_NAME') ?? ''
  if (!pretty) {
    pretty = [keyValues.get('NAME'), keyValues.get('VERSION_ID')].filter(Boolean).join(' ')
  }
  if (!pretty) pretty = [system, release].filter(Boolean).join(' ')
  return { system, release, arch, hostname, pretty }
}

function parseUptime(lines: string[], now: number): number | null {
  const line = firstLine(cleanLines(lines))
  if (!line) return null
  if (line.startsWith('{')) {
    const seconds = /sec\s*=\s*(\d+)/.exec(line)
    if (!seconds) return null
    return Math.max(0, Math.round(now / 1000 - Number(seconds[1])))
  }
  const seconds = toNumber(line.split(/\s+/)[0])
  return seconds === null ? null : Math.max(0, Math.round(seconds))
}

function parseLoad(lines: string[]): [number, number, number] | null {
  const line = firstLine(cleanLines(lines))
  if (!line) return null
  const values = (line.match(/(\d+\.\d+|\d+)/g) ?? []).slice(0, 3).map(Number)
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return null
  return [values[0], values[1], values[2]]
}

function parseCpu(lines: string[]): { busy: number; total: number } | null {
  const line = firstLine(cleanLines(lines))
  if (!line) return null
  const numbers = (line.match(/\d+/g) ?? []).map(Number)
  if (numbers.length < 4) return null
  // Linux: user nice system idle iowait irq softirq steal; BSD: user nice sys intr idle.
  const idle = line.startsWith('cpu') ? numbers[3] + (numbers[4] ?? 0) : numbers[4] ?? 0
  const total = numbers.reduce((sum, value) => sum + value, 0)
  return { busy: Math.max(0, total - idle), total }
}

function parseMemory(lines: string[]): WebsshMonitorMemory {
  const cleaned = cleanLines(lines)
  const values = new Map<string, number>()
  for (const line of cleaned) {
    const match = /^(\w+):?\s+(\d+)/.exec(line)
    if (match) values.set(match[1], Number(match[2]))
  }
  if (values.has('MemTotal')) {
    const total = values.get('MemTotal')! * 1024
    const available = (values.get('MemAvailable') ?? ((values.get('MemFree') ?? 0) + (values.get('Buffers') ?? 0) + (values.get('Cached') ?? 0))) * 1024
    const swapTotal = values.has('SwapTotal') ? values.get('SwapTotal')! * 1024 : null
    const swapFree = values.has('SwapFree') ? values.get('SwapFree')! * 1024 : null
    return {
      totalBytes: total,
      usedBytes: Math.max(0, total - available),
      availableBytes: available,
      swapTotalBytes: swapTotal,
      swapUsedBytes: swapTotal === null || swapFree === null ? null : Math.max(0, swapTotal - swapFree),
    }
  }
  const numbers = cleaned[0] ? cleaned[0].split(/\s+/).map(Number) : []
  if (numbers.length >= 7 && numbers.every((value) => Number.isFinite(value))) {
    const total = numbers[0]
    const pageSize = numbers[1]
    const available = (numbers[2] + numbers[3] + numbers[6]) * pageSize
    const swapTotal = numbers.length > 7 ? numbers[7] : null
    return {
      totalBytes: total,
      usedBytes: Math.max(0, total - available),
      availableBytes: available,
      swapTotalBytes: swapTotal,
      swapUsedBytes: null,
    }
  }
  return { totalBytes: null, usedBytes: null, availableBytes: null, swapTotalBytes: null, swapUsedBytes: null }
}

function parseDisks(lines: string[]): WebsshMonitorDisk[] {
  const disks: WebsshMonitorDisk[] = []
  const seen = new Set<string>()
  for (const line of cleanLines(lines).slice(1)) {
    const fields = line.split(/\s+/)
    if (fields.length < 6) continue
    const total = toNumber(fields[1])
    const used = toNumber(fields[2])
    const available = toNumber(fields[3])
    const mount = fields.slice(5).join(' ')
    if (total === null || mount.length === 0 || seen.has(mount)) continue
    if (total <= 0 && (available ?? 0) <= 0) continue
    seen.add(mount)
    disks.push({
      mount,
      totalBytes: toBytesFromBlocks(total),
      usedBytes: toBytesFromBlocks(used),
      availableBytes: toBytesFromBlocks(available),
      usedPercent: total > 0 && used !== null && available !== null && used + available > 0
        ? Math.round((used / (used + available)) * 1000) / 10
        : null,
    })
    if (disks.length >= 6) break
  }
  return disks
}

function parseLinuxNetwork(lines: string[]): WebsshMonitorNetworkInterface[] {
  const interfaces: WebsshMonitorNetworkInterface[] = []
  for (const line of cleanLines(lines)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const name = match[1].trim()
    if (name === 'lo' || name === 'Inter-|' || name === 'face') continue
    const fields = match[2].split(/\s+/)
    const rx = toNumber(fields[0])
    const tx = toNumber(fields[8])
    if (rx === null || tx === null) continue
    interfaces.push({ name, rxBytes: rx, txBytes: tx, rx: null, tx: null })
  }
  return interfaces
}

function parseBsdNetwork(lines: string[]): WebsshMonitorNetworkInterface[] {
  const cleaned = cleanLines(lines)
  const headerIndex = cleaned.findIndex((line) => /\bName\b/.test(line) && /\bIpkts\b/.test(line))
  if (headerIndex < 0) return []
  const header = cleaned[headerIndex].split(/\s+/)
  const rxIndex = header.indexOf('Ibytes') >= 0 ? header.indexOf('Ibytes') : header.indexOf('Bytes')
  const txIndex = header.indexOf('Obytes')
  if (rxIndex < 0 || txIndex < 0) return []
  const interfaces: WebsshMonitorNetworkInterface[] = []
  const seen = new Map<string, WebsshMonitorNetworkInterface>()
  for (const line of cleaned.slice(headerIndex + 1)) {
    const fields = line.split(/\s+/)
    const name = fields[0]
    if (!name || name.startsWith('lo')) continue
    const rx = toNumber(fields[rxIndex])
    const tx = toNumber(fields[txIndex])
    if (rx === null || tx === null) continue
    const existing = seen.get(name)
    if (existing) {
      existing.rxBytes = Math.max(existing.rxBytes, rx)
      existing.txBytes = Math.max(existing.txBytes, tx)
      continue
    }
    const entry: WebsshMonitorNetworkInterface = { name, rxBytes: rx, txBytes: tx, rx: null, tx: null }
    seen.set(name, entry)
    interfaces.push(entry)
  }
  return interfaces
}

export function parseNetwork(lines: string[]): WebsshMonitorNetworkInterface[] {
  const linux = parseLinuxNetwork(lines)
  return linux.length ? linux : parseBsdNetwork(lines)
}

function parseProcessLine(line: string): WebsshMonitorProcess | null {
  const fields = line.trim().split(/\s+/)
  if (fields.length < 11) return null
  const pid = toNumber(fields[1])
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return null
  const cpuPercent = toNumber(fields[2])
  const memPercent = toNumber(fields[3])
  const rss = toNumber(fields[5])
  if (cpuPercent === null || memPercent === null) return null
  return {
    pid,
    user: fields[0],
    cpuPercent,
    memPercent,
    rssBytes: (rss ?? 0) * 1024,
    state: fields[7] ?? '',
    command: fields.slice(10).join(' '),
  }
}

function parseProcessList(lines: string[]): WebsshMonitorProcess[] {
  const cleaned = cleanLines(lines)
  const processes: WebsshMonitorProcess[] = []
  const basic = Boolean(cleaned[0]) && /\bPID\b/.test(cleaned[0]) && !/%CPU/.test(cleaned[0])
  for (const line of cleaned) {
    const head = line.trim().split(/\s+/)
    if (/\bPID\b/.test(head[0] ?? '') || /\bPID\b/.test(head[1] ?? '')) continue
    if (basic) {
      const fields = head
      const pid = toNumber(fields[0])
      if (pid === null || !Number.isInteger(pid) || pid <= 0) continue
      processes.push({
        pid,
        user: fields[1] ?? '',
        cpuPercent: 0,
        memPercent: 0,
        rssBytes: 0,
        state: '',
        command: fields.slice(3).join(' '),
      })
      continue
    }
    const process = parseProcessLine(line)
    if (process) processes.push(process)
  }
  return processes
}

function isMonitorHelper(command: string): boolean {
  return command === 'ps aux'
    || command === 'wc -l'
    || command.startsWith('sort -k')
    || command.startsWith('head -n ')
    || command.includes('@@OS')
    || command.includes('@@PSMEM')
}

function parseProcesses(sections: Map<string, string[]>): WebsshMonitorProcesses {
  const totalLines = cleanLines(sections.get('PS'))
  const totalField = toNumber(totalLines[0]?.split(/\s+/).find((field) => /\d+/.test(field)) ?? '')
  const visible = (list: WebsshMonitorProcess[]) => list.filter((process) => !isMonitorHelper(process.command))
  const byCpu = visible(parseProcessList(totalLines.slice(1))).sort((left, right) => right.cpuPercent - left.cpuPercent)
  const byMemory = visible(parseProcessList(cleanLines(sections.get('PSMEM')))).sort((left, right) => right.memPercent - left.memPercent)
  const truncated = byCpu.length >= 60 || byMemory.length >= 40
  return {
    total: totalField === null ? new Set([...byCpu, ...byMemory].map((process) => process.pid)).size : Math.max(0, Math.round(totalField)),
    byCpu: byCpu.slice(0, PROCESS_LIMIT),
    byMemory: byMemory.slice(0, PROCESS_LIMIT),
    truncated,
  }
}

function parseContainers(sections: Map<string, string[]>): WebsshMonitorContainers {
  const available = sections.has('DOCKER_OK')
  const stats = new Map<string, { cpu: number | null; memory: string; network: string }>()
  for (const line of cleanLines(sections.get('DSTATS'))) {
    const [id, cpu, memory, network] = line.split('|')
    if (!id) continue
    stats.set(id.slice(0, 12), { cpu: toNumber(cpu), memory: memory ?? '', network: network ?? '' })
  }
  const items: WebsshMonitorContainer[] = []
  for (const line of cleanLines(sections.get('DOCKER_OK'))) {
    const [id, name, image, state, status] = line.split('|')
    if (!id || !name) continue
    const stat = stats.get(id.slice(0, 12))
    items.push({
      id,
      name,
      image: image ?? '',
      state: state ?? '',
      status: status ?? '',
      cpuPercent: stat?.cpu ?? null,
      memoryUsage: stat?.memory ?? '',
      networkIo: stat?.network ?? '',
    })
    if (items.length >= 50) break
  }
  return { available, truncated: items.length >= 50, items }
}

export function parseMonitorOutput(output: string, now: number, previous: MonitorCounters | null): ParsedMonitor {
  const sections = splitMonitorSections(output)
  const osLines = cleanLines(sections.get('OS'))
  const bootTime = osLines.slice(4).join('\n')
  const cpu = parseCpu(sections.get('CPU') ?? [])
  const interfaces = parseNetwork(sections.get('NET') ?? []).slice(0, INTERFACE_LIMIT)
  let cpuPercent: number | null = null
  if (cpu && previous?.cpu) {
    const total = cpu.total - previous.cpu.total
    const busy = cpu.busy - previous.cpu.busy
    if (total > 0 && busy >= 0) cpuPercent = Math.min(100, Math.round((busy / total) * 1000) / 10)
  }
  const seconds = previous ? Math.max(0.001, (now - previous.at) / 1000) : 0
  for (const entry of interfaces) {
    const last = previous?.network.get(entry.name)
    if (last && seconds > 0) {
      entry.rx = Math.max(0, Math.round((entry.rxBytes - last.rx) / seconds))
      entry.tx = Math.max(0, Math.round((entry.txBytes - last.tx) / seconds))
    }
  }
  const total = interfaces.reduce(
    (sum, entry) => ({
      rxBytes: sum.rxBytes + entry.rxBytes,
      txBytes: sum.txBytes + entry.txBytes,
      rx: sum.rx === null || entry.rx === null ? null : sum.rx + entry.rx,
      tx: sum.tx === null || entry.tx === null ? null : sum.tx + entry.tx,
    }),
    { rxBytes: 0, txBytes: 0, rx: 0 as number | null, tx: 0 as number | null },
  )
  if (interfaces.length === 0) {
    total.rx = null
    total.tx = null
  }
  const counters: MonitorCounters = {
    cpu,
    network: new Map(interfaces.map((entry) => [entry.name, { rx: entry.rxBytes, tx: entry.txBytes }])),
    at: now,
  }
  return {
    resources: {
      os: parseOs(osLines, bootTime),
      uptimeSeconds: parseUptime(sections.get('UPTIME') ?? [], now),
      load: parseLoad(sections.get('LOAD') ?? []),
      cpuPercent,
      memory: parseMemory(sections.get('MEM') ?? []),
      disks: parseDisks(sections.get('DISK') ?? []),
    },
    network: { total, interfaces },
    processes: parseProcesses(sections),
    containers: parseContainers(sections),
    truncated: false,
    counters,
  }
}

export function emptySnapshot(now: number): WebsshMonitorSnapshot {
  return {
    sampledAt: now,
    resources: {
      os: { system: '', release: '', arch: '', hostname: '', pretty: '' },
      uptimeSeconds: null,
      load: null,
      cpuPercent: null,
      memory: { totalBytes: null, usedBytes: null, availableBytes: null, swapTotalBytes: null, swapUsedBytes: null },
      disks: [],
    },
    network: { total: { rxBytes: 0, txBytes: 0, rx: null, tx: null }, interfaces: [] },
    processes: { total: 0, byCpu: [], byMemory: [], truncated: false },
    containers: { available: false, truncated: false, items: [] },
  }
}
