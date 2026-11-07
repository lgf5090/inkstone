import { describe, expect, it } from 'vitest'
import { parseOsc7Path, resolveCdCommand } from '../src/client/features/webssh/use-terminal-cwd'
import { fileEditorLanguage } from '../src/client/features/webssh/SftpCodeEditor'

describe('terminal cwd tracking', () => {
  it('resolves absolute, relative, home and parent cd targets', () => {
    expect(resolveCdCommand('cd /var/log', '/home/deploy', '/home/deploy')).toBe('/var/log')
    expect(resolveCdCommand('cd logs', '/var', '/home/deploy')).toBe('/var/logs')
    expect(resolveCdCommand('cd ..', '/var/log', '/home/deploy')).toBe('/var')
    expect(resolveCdCommand('cd', '/var/log', '/home/deploy')).toBe('/home/deploy')
    expect(resolveCdCommand('cd ~/app', '/', '/home/deploy')).toBe('/home/deploy/app')
    expect(resolveCdCommand('  cd   "my dir"  ', '/home/deploy', '/home/deploy')).toBe('/home/deploy/my dir')
  })

  it('ignores commands that could run more than a plain cd', () => {
    expect(resolveCdCommand('cd /tmp && rm -rf /', '/', '/')).toBeNull()
    expect(resolveCdCommand('ls -la', '/', '/')).toBeNull()
    expect(resolveCdCommand('cd $(pwd)', '/', '/')).toBeNull()
  })

  it('reads the OSC 7 file URL a shell prompt emits', () => {
    expect(parseOsc7Path('\u001b]7;file://host/var/log\u0007')).toBe('/var/log')
    expect(parseOsc7Path('\u001b]7;file://host/home/deploy/my%20app\u001b\\')).toBe('/home/deploy/my app')
    expect(parseOsc7Path('plain output')).toBeNull()
  })

  it('chooses a CodeMirror language from the file extension', () => {
    expect(fileEditorLanguage('app.ts')).toBe('javascript')
    expect(fileEditorLanguage('data.json')).toBe('json')
    expect(fileEditorLanguage('README.md')).toBe('markdown')
    expect(fileEditorLanguage('query.sql')).toBe('sql')
    expect(fileEditorLanguage('nginx.conf')).toBe('plain')
  })
})
