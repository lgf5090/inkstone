import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, ExternalLink, Link2, RotateCcw, SquareTerminal, Zap } from 'lucide-react'
import { xgetPathPrefix } from '@shared/development/xget/catalog'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { copyText } from '../../../../lib/clipboard'
import { Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { useUiStore } from '../../../../lib/ui-store'
import { xgetApi, describeXgetError } from '../api'
import { buildCommands, detectPlatform, type DetectedUrl } from '../utils/commands'
import { PlatformBadge } from './PlatformBadge'
import { PlatformIcon } from './PlatformIcon'
import type { XgetHistoryItem } from '../lib/history'

const EXAMPLE_URL = 'https://github.com/microsoft/vscode/archive/refs/heads/main.zip'

interface ConverterBarProps {
  proxyBase: string
  input: string
  onInputChange: (value: string) => void
  convertSignal: number
  onHistory: (item: XgetHistoryItem) => void
}

export function ConverterBar({ proxyBase, input, onInputChange, convertSignal, onHistory }: ConverterBarProps) {
  const [detected, setDetected] = useState<DetectedUrl | null>(null)
  const [converted, setConverted] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedCommand, setCopiedCommand] = useState('')
  const inputRef = useRef(input)
  inputRef.current = input
  const debounceRef = useRef<number | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const testRequestRef = useRef(0)

  function perform(value: string): { detected: DetectedUrl | null; converted: string } {
    testRequestRef.current += 1
    setTesting(false)
    const nextDetected = detectPlatform(value)
    const nextConverted =
      nextDetected && proxyBase
        ? `${proxyBase.replace(/\/+$/, '')}/${xgetPathPrefix(nextDetected.platform.key)}${nextDetected.url.pathname}${nextDetected.url.search}`
        : ''
    setDetected(nextDetected)
    setConverted(nextConverted)
    setTestResult(null)
    if (nextDetected && nextConverted) {
      onHistory({
        url: value.trim(),
        result: nextConverted,
        key: nextDetected.platform.key,
        time: Date.now(),
      })
    }
    return { detected: nextDetected, converted: nextConverted }
  }

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    testRequestRef.current += 1
    setTesting(false)
    const value = input.trim()
    if (!value) {
      setDetected(null)
      setConverted('')
      setTestResult(null)
      return
    }
    debounceRef.current = window.setTimeout(() => {
      const nextDetected = detectPlatform(value)
      setDetected(nextDetected)
      setConverted(
        nextDetected && proxyBase
          ? `${proxyBase.replace(/\/+$/, '')}/${xgetPathPrefix(nextDetected.platform.key)}${nextDetected.url.pathname}${nextDetected.url.search}`
          : '',
      )
    }, 250)
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [input, proxyBase])

  useEffect(() => {
    if (convertSignal === 0) return
    perform(inputRef.current)
  }, [convertSignal])

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
  }, [])

  async function copy(value: string, key: string): Promise<void> {
    const ok = await copyText(value)
    if (!ok) {
      useUiStore.getState().toast(t('development.xget.converter.copy_failed'), 'error')
      return
    }
    useUiStore.getState().toast(t('development.xget.common.copied'), 'success')
    if (key === 'result') {
      setCopied(true)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
    } else {
      setCopiedCommand(key)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopiedCommand(''), 1500)
    }
  }

  function useExample(): void {
    onInputChange(EXAMPLE_URL)
    perform(EXAMPLE_URL)
  }

  async function testLink(): Promise<void> {
    if (!detected || !converted) return
    const requestId = ++testRequestRef.current
    setTesting(true)
    setTestResult(null)
    try {
      const result = await xgetApi.testTarget(
        `/${xgetPathPrefix(detected.platform.key)}${detected.url.pathname}`,
      )
      if (requestId !== testRequestRef.current) return
      const okText = t('development.xget.converter.test_ok', { url: result.target_url })
      setTestResult({ ok: true, text: okText })
      useUiStore.getState().toast(okText, 'success')
    } catch (error) {
      if (requestId !== testRequestRef.current) return
      const failure = t('development.xget.converter.test_fail', { msg: describeXgetError(error) })
      setTestResult({ ok: false, text: failure })
    } finally {
      if (requestId === testRequestRef.current) setTesting(false)
    }
  }

  function openResult(): void {
    if (converted) window.open(converted, '_blank', 'noopener,noreferrer')
  }

  const commands = detected && converted ? buildCommands(converted, detected.platform.key) : []

  return (
    <div className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full min-w-0 basis-full sm:w-auto sm:basis-auto sm:flex-1">
          <Input
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyUp={(event) => {
              if (event.key === 'Enter') perform(input)
            }}
            aria-label={t('development.xget.converter.input_label')}
            placeholder={t('development.xget.converter.placeholder')}
            leading={<Link2 size={15} />}
            className="font-mono text-[length:var(--text-13)]"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={useExample} className="shrink-0">
          {t('development.xget.converter.paste_example')}
        </Button>
        <Button variant="primary" size="sm" icon={<Zap size={15} />} onClick={() => perform(input)} className="ml-auto shrink-0 sm:ml-0">
          {t('development.xget.converter.convert')}
        </Button>
      </div>

      {detected ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-13)]">
          <PlatformIcon platformKey={detected.platform.key} category={detected.platform.category} size="sm" />
          <span className="font-medium text-[var(--text-primary)]">{detected.platform.name}</span>
          <PlatformBadge platformKey={detected.platform.key} category={detected.platform.category} size="sm" />
          <span className="font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {detected.platform.hosts[0]}
          </span>
        </div>
      ) : input.trim() ? (
        <p className="mt-1.5 text-[length:var(--text-12)] text-[var(--danger)]">
          {t('development.xget.converter.not_detected')}
        </p>
      ) : null}

      {converted ? (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--accent)] bg-[var(--accent-softer)] px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-12)] text-[var(--accent)]" title={converted}>
              {converted}
            </code>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('development.xget.common.copy')}
              onClick={() => void copy(converted, 'result')}
              className="shrink-0"
            >
              {copied ? <Check size={14} className="text-[var(--success)]" /> : <Copy size={14} />}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="secondary" size="sm" icon={<ExternalLink size={13} />} onClick={openResult} className="text-[length:var(--text-12)]">
              {t('development.xget.converter.open')}
            </Button>
            <Button variant="secondary" size="sm" icon={<Download size={13} />} onClick={openResult} className="text-[length:var(--text-12)]">
              {t('development.xget.converter.download')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCcw size={13} className={cn(testing && 'animate-spin')} />}
              disabled={testing}
              onClick={() => void testLink()}
              className="text-[length:var(--text-12)]"
            >
              {testing ? t('development.xget.converter.testing') : t('development.xget.converter.test')}
            </Button>
            {commands.map((command) => (
              <Button
                key={command.name}
                variant="ghost"
                size="sm"
                icon={<SquareTerminal size={13} />}
                title={command.command}
                onClick={() => void copy(command.command, command.name)}
                className="border border-dashed border-[var(--border-subtle)] text-[length:var(--text-12)] text-[var(--text-tertiary)]"
              >
                {copiedCommand === command.name ? <Check size={13} className="text-[var(--success)]" /> : command.name}
              </Button>
            ))}
          </div>
          {testResult && (
            <p
              role="status"
              className={cn(
                'truncate font-mono text-[length:var(--text-11)]',
                testResult.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]',
              )}
            >
              {testResult.text}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
