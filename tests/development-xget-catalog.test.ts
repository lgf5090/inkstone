// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  XGET_PLATFORM_KEYS,
  XGET_PLATFORMS,
  xgetPathPrefix,
  type XgetPlatformKey,
} from '../src/shared/development/xget/catalog'
import {
  buildCommands,
  buildEcosystemCommands,
  buildProxyUrl,
  detectPlatform,
} from '../src/client/features/development/xget/utils/commands'
import { PLATFORM_DESCRIPTION_KEYS } from '../src/client/features/development/xget/utils/platform-meta'
import { PLATFORM_ICONS } from '../src/client/features/development/xget/utils/platform-icons'
import {
  getPlatformGuide,
  renderGuideCommand,
} from '../src/client/features/development/xget/utils/platform-guides'
import { EN_US_DEVELOPMENT_XGET_GUIDES } from '../src/shared/locales/en-US-development-xget-guides'
import { EN_US_DEVELOPMENT_XGET_PLATFORMS } from '../src/shared/locales/en-US-development-xget-platforms'
import { ZH_CN_DEVELOPMENT_XGET_GUIDES } from '../src/shared/locales/zh-CN-development-xget-guides'
import { ZH_CN_DEVELOPMENT_XGET_PLATFORMS } from '../src/shared/locales/zh-CN-development-xget-platforms'

const enPlatforms: Record<string, string> = { ...EN_US_DEVELOPMENT_XGET_PLATFORMS }
const zhPlatforms: Record<string, string> = { ...ZH_CN_DEVELOPMENT_XGET_PLATFORMS }
const enGuides: Record<string, string> = { ...EN_US_DEVELOPMENT_XGET_GUIDES }
const zhGuides: Record<string, string> = { ...ZH_CN_DEVELOPMENT_XGET_GUIDES }

describe('the Xget platform catalogue', () => {
  it('lists 84 platforms with unique keys', () => {
    expect(XGET_PLATFORMS).toHaveLength(84)
    expect(new Set(XGET_PLATFORM_KEYS).size).toBe(84)
  })

  it('describes every platform through a literal locale key', () => {
    const descriptionKeys = Object.keys(PLATFORM_DESCRIPTION_KEYS) as XgetPlatformKey[]
    expect(new Set(descriptionKeys)).toEqual(new Set(XGET_PLATFORM_KEYS))
    for (const key of descriptionKeys) {
      const localeKey = `development.xget.platform.${key.replace(/-/g, '_')}.desc`
      expect(PLATFORM_DESCRIPTION_KEYS[key]).toBe(localeKey)
      expect(enPlatforms[localeKey]).toBeTruthy()
      expect(zhPlatforms[localeKey]).toBeTruthy()
    }
  })

  it('maps the recorded brands and leaves unlisted ones to the category fallback', () => {
    expect(PLATFORM_ICONS.gh?.slug).toBe('github')
    expect(PLATFORM_ICONS['cr-docker']?.slug).toBe('docker')
    expect(PLATFORM_ICONS['ip-anthropic']?.slug).toBe('anthropic')
    expect(PLATFORM_ICONS['ip-openai']).toBeUndefined()
    expect(PLATFORM_ICONS['pypi-files']).toBeUndefined()
  })
})

describe('the Xget platform guides', () => {
  const specificKeys = [
    'gh', 'gist', 'gl', 'hf', 'npm', 'pypi', 'conda', 'maven', 'gradle', 'homebrew',
    'rubygems', 'cran', 'cpan', 'ctan', 'golang', 'nuget', 'crates', 'packagist',
    'flathub', 'debian', 'ubuntu', 'fedora', 'rocky', 'opensuse', 'arch', 'arxiv',
    'fdroid', 'jenkins', 'apache', 'sf', 'aosp', 'civitai',
  ]

  it('uses a specific guide for the 32 authored platforms', () => {
    expect(specificKeys).toHaveLength(32)
    for (const key of specificKeys) {
      expect(getPlatformGuide(key, key).summaryKey).toBe(`development.xget.guide.${key}.summary`)
    }
  })

  it('falls back to the registry, AI and generic templates', () => {
    expect(getPlatformGuide('cr-docker', 'Docker Hub').summaryKey).toBe(
      'development.xget.guide.category.registry.summary',
    )
    expect(getPlatformGuide('ip-groq', 'Groq').summaryKey).toBe(
      'development.xget.guide.category.ai.summary',
    )
    expect(getPlatformGuide('gitea', 'Gitea').summaryKey).toBe(
      'development.xget.guide.category.generic.summary',
    )
  })

  it('gives every platform a non-empty guide in both languages', () => {
    for (const platform of XGET_PLATFORMS) {
      const guide = getPlatformGuide(platform.key, platform.name)
      expect(guide.format.startsWith(`{proxy}/${xgetPathPrefix(platform.key)}/`)).toBe(true)
      expect(guide.sections.length).toBeGreaterThan(0)
      expect(enGuides[guide.summaryKey]).toBeTruthy()
      expect(zhGuides[guide.summaryKey]).toBeTruthy()
      for (const section of guide.sections) {
        expect(section.commands.length).toBeGreaterThan(0)
        expect(enGuides[section.titleKey]).toBeTruthy()
        expect(zhGuides[section.titleKey]).toBeTruthy()
        if (section.noteKey) {
          expect(enGuides[section.noteKey]).toBeTruthy()
          expect(zhGuides[section.noteKey]).toBeTruthy()
        }
        for (const command of section.commands) {
          expect(command.cmd.length).toBeGreaterThan(0)
          expect(command.cmd).toMatch(/^[\x20-\x7e\n]+$/)
          if (command.labelKey) {
            expect(enGuides[command.labelKey]).toBeTruthy()
            expect(zhGuides[command.labelKey]).toBeTruthy()
          }
        }
      }
    }
  })

  it('renders a registry mirror instead of a path-prefixed docker pull', () => {
    const guide = getPlatformGuide('cr-docker', 'Docker Hub')
    const rendered = guide.sections
      .flatMap((section) => section.commands.map((command) => renderGuideCommand(command.cmd, 'https://proxy.example/api/xget')))
      .join('\n')
    expect(rendered).toContain('registry-mirrors')
    expect(rendered).toContain('https://proxy.example/api/xget/cr/docker')
    expect(rendered).not.toContain('docker pull https://proxy.example')
  })

  it('renders trusted hosts as a host name, not a proxy path', () => {
    const command = getPlatformGuide('pypi', 'PyPI').sections[1].commands[1].cmd
    expect(renderGuideCommand(command, 'http://localhost:8787/api/xget')).toBe(
      'pip config set global.trusted-host localhost:8787',
    )
  })

  it('uses a language-neutral generic URL example', () => {
    const commands = getPlatformGuide('homebrew-api', 'Homebrew API').sections.flatMap((section) =>
      section.commands.map((command) => command.cmd),
    )
    expect(commands.join('\n')).not.toContain('Original:')
    expect(commands.join('\n')).not.toContain('Accelerated:')
  })
})

describe('the Xget URL detection', () => {
  it('matches host plus path prefixes before plain hosts', () => {
    const cases: [string, string][] = [
      ['https://github.com/microsoft/vscode/archive/refs/heads/main.zip', 'gh'],
      ['https://github.com/Homebrew/homebrew-core/raw/HEAD/Formula/g/git.rb', 'homebrew'],
      ['https://formulae.brew.sh/api/formula/git.json', 'homebrew-api'],
      ['https://ghcr.io/v2/homebrew/core/git/manifests/2.39.0', 'homebrew-bottles'],
      ['https://formulae.brew.sh/formula/git', 'homebrew'],
      ['https://registry-1.docker.io/v2/library/nginx/manifests/latest', 'cr-docker'],
      ['https://api.openai.com/v1/chat/completions', 'ip-openai'],
      ['http://github.com/facebook/react', 'gh'],
    ]
    for (const [input, key] of cases) {
      expect(detectPlatform(input)?.platform.key).toBe(key)
    }
  })

  it('accepts only supported absolute http URLs', () => {
    expect(detectPlatform('ftp://github.com/facebook/react')).toBeNull()
    expect(detectPlatform('file:///etc/passwd')).toBeNull()
    expect(detectPlatform('not a url')).toBeNull()
    expect(detectPlatform('https://example.com/archive.zip')).toBeNull()
  })
})

describe('the Xget URL builder', () => {
  it('prefixes dotted platform keys onto the trimmed base', () => {
    expect(
      buildProxyUrl(
        'https://proxy.example/api/development/xget/',
        'ip-openai',
        '/v1/chat/completions',
        '?stream=1',
      ),
    ).toBe('https://proxy.example/api/development/xget/ip/openai/v1/chat/completions?stream=1')
    expect(
      buildProxyUrl(
        'https://proxy.example/api/development/xget',
        'cr-docker',
        '/v2/library/nginx/manifests/latest',
      ),
    ).toBe('https://proxy.example/api/development/xget/cr/docker/v2/library/nginx/manifests/latest')
  })
})

describe('the Xget download commands', () => {
  it('offers git clone only for repository roots of git platforms', () => {
    const repo = buildCommands('https://proxy.example/api/xget/gh/microsoft/vscode', 'gh')
    expect(repo.map((entry) => entry.name)).toEqual(['git clone', 'wget', 'curl', 'aria2'])
    expect(repo[0]?.command).toBe('git clone https://proxy.example/api/xget/gh/microsoft/vscode.git')

    const trailing = buildCommands('https://proxy.example/api/xget/gh/microsoft/vscode/', 'gh')
    expect(trailing[0]?.command).toBe(
      'git clone https://proxy.example/api/xget/gh/microsoft/vscode.git',
    )

    const homebrew = buildCommands('https://proxy.example/api/xget/homebrew/homebrew-core', 'homebrew')
    expect(homebrew.map((entry) => entry.name)).toContain('git clone')

    const archive = buildCommands(
      'https://proxy.example/api/xget/gh/microsoft/vscode/archive/refs/heads/main.zip',
      'gh',
    )
    expect(archive.map((entry) => entry.name)).toEqual(['wget', 'curl', 'aria2'])

    const release = buildCommands(
      'https://proxy.example/api/xget/gh/microsoft/vscode/releases/download/v1.0.0/file.tar.gz',
      'gh',
    )
    expect(release.map((entry) => entry.name)).not.toContain('git clone')

    const raw = buildCommands(
      'https://proxy.example/api/xget/gh/microsoft/vscode/raw/main/README.md',
      'gh',
    )
    expect(raw.map((entry) => entry.name)).not.toContain('git clone')

    const crates = buildCommands(
      'https://proxy.example/api/xget/crates/api/v1/crates/serde/1.0.0/download',
      'crates',
    )
    expect(crates.map((entry) => entry.name)).toEqual(['wget', 'curl', 'aria2'])
  })

  it('builds the six ecosystem commands against the trimmed base', () => {
    const commands = buildEcosystemCommands('https://proxy.example/api/xget///')
    expect(commands.map((entry) => entry.name)).toEqual(['pip', 'npm', 'git', 'HF', 'conda', 'Go'])
    expect(commands.map((entry) => entry.command)).toEqual([
      'pip config set global.index-url https://proxy.example/api/xget/pypi/simple/',
      'npm config set registry https://proxy.example/api/xget/npm/',
      'git config --global url."https://proxy.example/api/xget/gh/".insteadOf "https://github.com/"',
      "export HF_ENDPOINT='https://proxy.example/api/xget/hf'",
      'conda config --set channel_alias https://proxy.example/api/xget/conda/community',
      'go env -w GOPROXY=https://proxy.example/api/xget/golang,direct',
    ])
  })
})

describe('the Xget locale catalogues', () => {
  it('keeps English and Chinese key sets equal', () => {
    expect(Object.keys(enPlatforms).sort()).toEqual(Object.keys(zhPlatforms).sort())
    expect(Object.keys(enGuides).sort()).toEqual(Object.keys(zhGuides).sort())
  })

  it('contains no untranslated Chinese or French copy in English', () => {
    const han = /\p{Script=Han}/u
    const french = /(?:télécharger|téléchargement|paquet|accélération|français|avec|pour)/i
    for (const value of [...Object.values(enPlatforms), ...Object.values(enGuides)]) {
      expect(value).not.toMatch(han)
      expect(value).not.toMatch(french)
    }
    expect(enPlatforms['development.xget.platform.gh.desc']).toContain('Git protocol')
    expect(enPlatforms['development.xget.platform.ip_openai.desc']).toContain('GPT')
    expect(enGuides['development.xget.guide.gh.summary']).toContain('GitHub')
    expect(enGuides['development.xget.guide.category.registry.summary']).toContain('{name}')
    expect(zhPlatforms['development.xget.platform.gh.desc']).not.toBe(
      enPlatforms['development.xget.platform.gh.desc'],
    )
    expect(zhPlatforms['development.xget.platform.gh.desc']).toContain('Release')
  })
})
