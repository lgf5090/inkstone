import { describe, expect, it } from 'vitest'
import { parseMonitorOutput, splitMonitorSections, WEBSSH_MONITOR_COMMAND } from '../src/worker/webssh/monitor/snapshot'

const LINUX_SAMPLE = [
  '@@OS',
  'Linux',
  '6.8.0-45-generic',
  'x86_64',
  'box',
  'PRETTY_NAME="Ubuntu 24.04 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="24.04"',
  '@@UPTIME',
  '4321.50 1024.00',
  '@@LOAD',
  '0.42 0.31 0.25 2/312 8891',
  '@@CPU',
  'cpu  101 2 33 400 5 0 1 0 0 0',
  '@@MEM',
  'MemTotal:       8000000 kB',
  'MemFree:        1000000 kB',
  'MemAvailable:   4000000 kB',
  'Buffers:          100000 kB',
  'Cached:         2000000 kB',
  'SwapTotal:      2000000 kB',
  'SwapFree:       1500000 kB',
  '@@DISK',
  'Filesystem     1024-blocks    Used Available Capacity Mounted on',
  '/dev/sda1        100000000 40000000  55000000      43% /',
  '@@NET',
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0',
  '  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0',
  '@@PS',
  '312',
  'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND',
  'root 1 0.0 0.1 123 456 ? Ss 10:00 0:01 /sbin/init',
  'alice 4321 12.5 3.2 456 789 ? S 10:10 1:00 node server.js',
  '@@PSMEM',
  'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND',
  'root 1 0.0 0.1 123 456 ? Ss 10:00 0:01 /sbin/init',
  'alice 4321 12.5 3.2 456 789 ? S 10:10 1:00 node server.js',
  '@@DOCKER',
  '@@DOCKER_OK',
  'abc123|web|nginx:latest|running|Up 2 hours',
  '@@DSTATS',
  'abc123|1.25%|10MiB / 100MiB|1kB / 2kB',
  '@@END',
].join('\n')

const FREEBSD_SAMPLE = [
  '@@OS',
  'FreeBSD',
  '14.1-RELEASE',
  'amd64',
  'bsdbox',
  '14.1-RELEASE',
  '@@UPTIME',
  '{ sec = 1700000000, usec = 0 } Wed Nov  6 10:00:00 2024',
  '@@LOAD',
  '{ 0.10 0.20 0.30 }',
  '@@CPU',
  '10 1 5 2 900',
  '@@MEM',
  '17179869184 4096 500000 100000 200000 50000 300000 0',
  '@@DISK',
  'Filesystem 1024-blocks Used Available Capacity Mounted on',
  '/dev/ada0p2 100000000 40000000 55000000 43% /',
  '@@NET',
  'Name    Mtu Network       Address              Ipkts Ierrs Idrops      Bytes Opkts Oerrs     Obytes Coll',
  'em0    1500 <Link#1>      00:11:22:33:44:55    100     0     0       5000   200     0       6000    0',
  'lo0   16384 127           127.0.0.1             10     0     0        100    10     0        100    0',
  '@@PS',
  '240',
  'USER    PID %CPU %MEM  VSZ  RSS TT  STAT STARTED    TIME COMMAND',
  'root      1  0.0  0.0 9000 1000  -  SLs  10:00   0:00 /sbin/init',
  'user   777  4.5  1.1 1200 3000  -  S    10:30   0:01 /usr/local/bin/daemon',
  '@@PSMEM',
  'USER    PID %CPU %MEM  VSZ  RSS TT  STAT STARTED    TIME COMMAND',
  'root      1  0.0  0.0 9000 1000  -  SLs  10:00   0:00 /sbin/init',
  'user   777  4.5  1.1 1200 3000  -  S    10:30   0:01 /usr/local/bin/daemon',
  '@@DOCKER',
  '@@END',
].join('\n')

describe('webssh monitor snapshot', () => {
  it('keeps the remote command on one line and inside the exec limit', () => {
    expect(WEBSSH_MONITOR_COMMAND).not.toMatch(/[\r\n\0]/)
    expect(WEBSSH_MONITOR_COMMAND.length).toBeLessThan(4096)
  })

  it('splits marker-delimited output', () => {
    const sections = splitMonitorSections(LINUX_SAMPLE)
    expect(sections.get('OS')?.[0]).toBe('Linux')
    expect(sections.get('DOCKER_OK')?.[0]).toBe('abc123|web|nginx:latest|running|Up 2 hours')
    expect(sections.has('END')).toBe(true)
  })

  it('parses a Linux sample', () => {
    const parsed = parseMonitorOutput(LINUX_SAMPLE, 1_700_000_000_000, null)
    expect(parsed.resources.os).toMatchObject({ system: 'Linux', release: '6.8.0-45-generic', arch: 'x86_64', pretty: 'Ubuntu 24.04 LTS' })
    expect(parsed.resources.uptimeSeconds).toBe(4322)
    expect(parsed.resources.load).toEqual([0.42, 0.31, 0.25])
    expect(parsed.resources.cpuPercent).toBeNull()
    expect(parsed.resources.memory.totalBytes).toBe(8_000_000 * 1024)
    expect(parsed.resources.memory.availableBytes).toBe(4_000_000 * 1024)
    expect(parsed.resources.disks[0]).toMatchObject({ mount: '/', usedPercent: 42.1 })
    expect(parsed.network.interfaces).toHaveLength(1)
    expect(parsed.network.interfaces[0]).toMatchObject({ name: 'eth0', rxBytes: 1000, txBytes: 2000, rx: null, tx: null })
    expect(parsed.processes.total).toBe(312)
    expect(parsed.processes.byCpu[0]).toMatchObject({ pid: 4321, user: 'alice', cpuPercent: 12.5 })
    expect(parsed.containers.available).toBe(true)
    expect(parsed.containers.items[0]).toMatchObject({ name: 'web', image: 'nginx:latest', cpuPercent: 1.25 })
  })

  it('computes CPU and per-interface rates from the previous sample', () => {
    const first = parseMonitorOutput(LINUX_SAMPLE, 1_000, null)
    const second = LINUX_SAMPLE
      .replace('cpu  101 2 33 400 5 0 1 0 0 0', 'cpu  151 2 33 450 5 0 1 0 0 0')
      .replace('  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0', '  eth0: 1500 0 0 0 0 0 0 0 3000 0 0 0 0 0 0 0')
    const parsed = parseMonitorOutput(second, 11_000, first.counters)
    expect(parsed.resources.cpuPercent).toBe(50)
    expect(parsed.network.interfaces[0]).toMatchObject({ rx: 50, tx: 100 })
    expect(parsed.network.total).toMatchObject({ rx: 50, tx: 100 })
  })

  it('parses a busybox-style process list that has no CPU or memory columns', () => {
    const output = [
      '@@PS',
      '3',
      'PID USER TIME COMMAND',
      '1 root 0:00 sshd: /usr/sbin/sshd -D',
      '7 testuser 0:00 sleep 600',
      '@@PSMEM',
      'PID USER TIME COMMAND',
      '1 root 0:00 sshd: /usr/sbin/sshd -D',
      '7 testuser 0:00 sleep 600',
      '@@DOCKER',
      '@@END',
    ].join('\n')
    const parsed = parseMonitorOutput(output, 1_000, null)
    expect(parsed.processes.total).toBe(3)
    expect(parsed.processes.byCpu).toHaveLength(2)
    expect(parsed.processes.byCpu[0]).toMatchObject({ pid: 1, command: 'sshd: /usr/sbin/sshd -D' })
    expect(parsed.processes.byCpu[1]).toMatchObject({ pid: 7, command: 'sleep 600', cpuPercent: 0 })
  })

  it('parses a FreeBSD sample through sysctl and netstat fallbacks', () => {
    const parsed = parseMonitorOutput(FREEBSD_SAMPLE, 1_700_000_100_000, null)
    expect(parsed.resources.os).toMatchObject({ system: 'FreeBSD', release: '14.1-RELEASE', arch: 'amd64' })
    expect(parsed.resources.uptimeSeconds).toBe(100)
    expect(parsed.resources.load).toEqual([0.10, 0.20, 0.30])
    expect(parsed.resources.cpuPercent).toBeNull()
    expect(parsed.resources.memory.totalBytes).toBe(17179869184)
    expect(parsed.resources.memory.availableBytes).toBe((500000 + 100000 + 300000) * 4096)
    expect(parsed.network.interfaces[0]).toMatchObject({ name: 'em0', rxBytes: 5000, txBytes: 6000 })
    expect(parsed.processes.total).toBe(240)
    expect(parsed.processes.byCpu[0]).toMatchObject({ pid: 777, cpuPercent: 4.5, state: 'S' })
    expect(parsed.containers.available).toBe(false)
  })
})
