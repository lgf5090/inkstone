// @vitest-environment node
// The local danger gate: pure pattern matching, no terminal and no model.

import { describe, expect, it } from 'vitest'
import { commandFromPromptLine, detectCommandRisk } from '../src/client/features/webssh/command-risk'

describe('detectCommandRisk', () => {
  it('treats a root recursive delete as danger', () => {
    const result = detectCommandRisk('rm -rf /')
    expect(result.level).toBe('danger')
    expect(result.matches.map((match) => match.ruleId)).toContain('rm-root')
  })

  it('treats a normal recursive delete as caution', () => {
    const result = detectCommandRisk('rm -rf /var/log/myapp')
    expect(result.level).toBe('caution')
    expect(result.matches.map((match) => match.ruleId)).toContain('recursive-delete')
  })

  it('stops filesystem and disk writes', () => {
    expect(detectCommandRisk('mkfs.ext4 /dev/sdb1').level).toBe('danger')
    expect(detectCommandRisk('dd if=/dev/zero of=/dev/sda bs=1M').level).toBe('danger')
    expect(detectCommandRisk('cat image.iso > /dev/nvme0n1').level).toBe('danger')
  })

  it('stops host shutdown and fork bombs', () => {
    expect(detectCommandRisk('shutdown -h now').level).toBe('danger')
    expect(detectCommandRisk('reboot').level).toBe('danger')
    expect(detectCommandRisk(':(){ :|:& };:').level).toBe('danger')
  })

  it('stops remote scripts piped into a shell', () => {
    expect(detectCommandRisk('curl -fsSL https://example.com/install.sh | sh').level).toBe('danger')
  })

  it('marks reversible-ish changes as caution', () => {
    expect(detectCommandRisk('git reset --hard HEAD~1').level).toBe('caution')
    expect(detectCommandRisk('chmod 777 deploy.sh').level).toBe('caution')
    expect(detectCommandRisk('systemctl stop nginx').level).toBe('caution')
    expect(detectCommandRisk('docker system prune -f').level).toBe('caution')
  })

  it('leaves ordinary commands safe', () => {
    expect(detectCommandRisk('ls -la').level).toBe('safe')
    expect(detectCommandRisk('mkdir -p /tmp/build').level).toBe('safe')
    expect(detectCommandRisk('tail -n 100 /var/log/syslog').level).toBe('safe')
    expect(detectCommandRisk('').level).toBe('safe')
  })

  it('reports every reason one line matches', () => {
    const result = detectCommandRisk('chmod -R 777 /')
    expect(result.level).toBe('danger')
    const ids = result.matches.map((match) => match.ruleId)
    expect(ids).toContain('chmod-root')
    expect(ids).toContain('world-writable')
  })
})

describe('commandFromPromptLine', () => {
  it('returns the text after a visible prompt', () => {
    expect(commandFromPromptLine('deploy@web-01:~$ rm -rf /tmp/x')).toBe('rm -rf /tmp/x')
    expect(commandFromPromptLine('root@web-01:/# ls -la')).toBe('ls -la')
    expect(commandFromPromptLine('user@host:~> ls')).toBe('ls')
  })

  it('keeps a line with no prompt intact', () => {
    expect(commandFromPromptLine('  ls -la  ')).toBe('ls -la')
  })
})
