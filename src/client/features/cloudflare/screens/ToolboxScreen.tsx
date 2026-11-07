/**
 * The toolbox: DNS lookup, RDAP, HTTP probe, Cloudflare trace and a CIDR calculator.
 *
 * Four of the five tools call a public endpoint through the worker; the CIDR calculator runs locally.
 * Every panel owns its form and result, so a blocked endpoint never hides the others.
 */
import { useState } from 'react'
import { Play, Search } from 'lucide-react'
import { Field, Input } from '../../../components/form'
import { LoadingBlock } from '../../../components/feedback'
import { Button } from '../../../components/primitives'
import { SelectMenu } from '../../../components/select-menu'
import { cn } from '../../../lib/cn'
import { t as uiT } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { cfErrorText } from '../api/client'
import { toolboxApi, type ProbeResult, type RdapSummary } from '../api/toolbox'
import { useCfT, type CloudflareMessageKey } from '../i18n'
import { parseCidr, type CidrResult } from '../lib/cidr'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../components/Table'
import { Panel, PanelEmpty, PanelError } from './dashboard/Panel'

type ToolboxTab = 'dns' | 'rdap' | 'probe' | 'trace' | 'cidr'

const TABS: readonly { value: ToolboxTab; labelKey: CloudflareMessageKey }[] = [
  { value: 'dns', labelKey: 'cloudflare.toolbox.tabs.dns' },
  { value: 'rdap', labelKey: 'cloudflare.toolbox.tabs.rdap' },
  { value: 'probe', labelKey: 'cloudflare.toolbox.tabs.probe' },
  { value: 'trace', labelKey: 'cloudflare.toolbox.tabs.trace' },
  { value: 'cidr', labelKey: 'cloudflare.toolbox.tabs.cidr' },
]

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'CAA'].map((value) => ({ value, label: value }))

function DnsPanel() {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [name, setName] = useState('cloudflare.com')
  const [type, setType] = useState('A')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ status: number; answers: Array<{ name: string; type: number; ttl: number; data: string }> } | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setResult(await toolboxApi.dns(name.trim(), type))
    } catch (reason) {
      setError(cfErrorText(reason))
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={tcf('cloudflare.toolbox.tabs.dns')}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={tcf('cloudflare.toolbox.domain')} className="min-w-0 flex-1" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </Field>
        <Field label={tcf('cloudflare.toolbox.record_type')} className="w-32">
          <SelectMenu label={tcf('cloudflare.toolbox.record_type')} value={type} options={DNS_TYPES} onChange={setType} />
        </Field>
        <Button icon={<Search size={14} />} loading={busy} disabled={!name.trim()} onClick={() => void run()}>
          {tcf('cloudflare.toolbox.query')}
        </Button>
      </div>
      {error ? <div className="mt-3"><PanelError message={error} onRetry={() => void run()} /></div> : null}
      {result ? (
        <div className="mt-3">
          <p className="mb-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.status')} {result.status}</p>
          {result.answers.length === 0 ? <PanelEmpty>{tcf('cloudflare.toolbox.no_records')}</PanelEmpty> : (
            <TableScroll label={tcf('cloudflare.toolbox.tabs.dns')}>
              <Table>
                <THead><Tr><Th>{tcf('cloudflare.toolbox.name')}</Th><Th>{tcf('cloudflare.toolbox.ttl')}</Th><Th>{tcf('cloudflare.toolbox.value')}</Th></Tr></THead>
                <TBody>
                  {result.answers.map((answer, index) => (
                    <Tr key={`${answer.name}:${index}`}>
                      <Td className="break-all font-mono text-[length:var(--text-11)]">{answer.name}</Td>
                      <Td>{answer.ttl}</Td>
                      <Td className="break-all font-mono text-[length:var(--text-11)]">{answer.data}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableScroll>
          )}
        </div>
      ) : null}
    </Panel>
  )
}

function RdapPanel() {
  const tcf = useCfT()
  const [domain, setDomain] = useState('cloudflare.com')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RdapSummary | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setResult(await toolboxApi.rdap(domain.trim()))
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={tcf('cloudflare.toolbox.tabs.rdap')}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={tcf('cloudflare.toolbox.domain')} className="min-w-0 flex-1" required>
          <Input value={domain} onChange={(event) => setDomain(event.target.value)} autoComplete="off" />
        </Field>
        <Button icon={<Search size={14} />} loading={busy} disabled={!domain.trim()} onClick={() => void run()}>
          {tcf('cloudflare.toolbox.query')}
        </Button>
      </div>
      {error ? <div className="mt-3"><PanelError message={error} onRetry={() => void run()} /></div> : null}
      {result ? (
        <dl className="mt-3 grid grid-cols-1 gap-3 text-[length:var(--text-12-5)] sm:grid-cols-2">
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.domain')}</dt><dd className="break-all">{result.domain}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.handle')}</dt><dd className="break-all font-mono text-[length:var(--text-11)]">{result.handle || '—'}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.registrar')}</dt><dd>{result.registrar || '—'}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.status')}</dt><dd>{result.status.join(', ') || '—'}</dd></div>
          <div className="sm:col-span-2"><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.nameservers')}</dt><dd className="break-all font-mono text-[length:var(--text-11)]">{result.nameservers.join(', ') || '—'}</dd></div>
          <div className="sm:col-span-2">
            <dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.events')}</dt>
            <dd className="flex flex-col gap-1">
              {result.events.length === 0 ? '—' : result.events.map((event) => (
                <span key={`${event.action}:${event.date}`}>{event.action}: {event.date}</span>
              ))}
            </dd>
          </div>
        </dl>
      ) : null}
    </Panel>
  )
}

function ProbePanel() {
  const tcf = useCfT()
  const [url, setUrl] = useState('https://www.cloudflare.com/')
  const [method, setMethod] = useState<'GET' | 'HEAD'>('GET')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ProbeResult | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setResult(await toolboxApi.probe(url.trim(), method))
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={tcf('cloudflare.toolbox.tabs.probe')}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={tcf('cloudflare.toolbox.url_label')} className="min-w-0 flex-1" required>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" />
        </Field>
        <Field label={tcf('cloudflare.toolbox.method')} className="w-32">
          <SelectMenu
            label={tcf('cloudflare.toolbox.method')}
            value={method}
            options={[{ value: 'GET', label: 'GET' }, { value: 'HEAD', label: 'HEAD' }]}
            onChange={setMethod}
          />
        </Field>
        <Button icon={<Play size={14} />} loading={busy} disabled={!url.trim()} onClick={() => void run()}>
          {tcf('cloudflare.toolbox.run')}
        </Button>
      </div>
      {error ? <div className="mt-3"><PanelError message={error} onRetry={() => void run()} /></div> : null}
      {result ? (
        <div className="mt-3 flex flex-col gap-3">
          <dl className="grid grid-cols-1 gap-3 text-[length:var(--text-12-5)] sm:grid-cols-2">
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.status')}</dt><dd>{result.status} {result.statusText}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.elapsed')}</dt><dd>{result.elapsedMs} {tcf('cloudflare.toolbox.unit_ms')}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.final_url')}</dt><dd className="break-all">{result.finalUrl}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.content_type')}</dt><dd className="break-all">{result.contentType || '—'}</dd></div>
          </dl>
          <div>
            <p className="mb-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.headers')}</p>
            <pre className="max-h-48 overflow-auto rounded-[var(--r-md)] bg-[var(--bg-inset)] p-2 font-mono text-[length:var(--text-11)]">
              {Object.entries(result.headers).map(([key, value]) => `${key}: ${value}`).join('\n') || '—'}
            </pre>
          </div>
          {result.body ? (
            <div>
              <p className="mb-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.body')}{result.truncated ? ' (truncated)' : ''}</p>
              <pre className="max-h-64 overflow-auto rounded-[var(--r-md)] bg-[var(--bg-inset)] p-2 font-mono text-[length:var(--text-11)]">{result.body}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}

function TracePanel() {
  const tcf = useCfT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trace, setTrace] = useState<Record<string, string> | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setTrace((await toolboxApi.trace()).trace)
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={tcf('cloudflare.toolbox.tabs.trace')}
      actions={<Button size="sm" icon={<Play size={14} />} loading={busy} onClick={() => void run()}>{tcf('cloudflare.toolbox.run')}</Button>}
    >
      <p className="mb-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.trace_hint')}</p>
      {error ? <PanelError message={error} onRetry={() => void run()} /> : trace ? (
        <dl className="grid grid-cols-1 gap-2 text-[length:var(--text-12-5)] sm:grid-cols-2">
          {Object.entries(trace).map(([key, value]) => (
            <div key={key} className="flex gap-2 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1">
              <dt className="shrink-0 font-mono text-[var(--text-tertiary)]">{key}</dt>
              <dd className="min-w-0 break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      ) : !error && !busy ? <PanelEmpty>{tcf('cloudflare.toolbox.trace_empty')}</PanelEmpty> : null}
      {busy ? <LoadingBlock /> : null}
    </Panel>
  )
}

function CidrPanel() {
  const tcf = useCfT()
  const [value, setValue] = useState('192.168.0.0/24')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CidrResult | null>(null)

  function run(): void {
    setError(null)
    try {
      setResult(parseCidr(value))
    } catch {
      setResult(null)
      setError(tcf('cloudflare.toolbox.cidr_invalid'))
    }
  }

  return (
    <Panel title={tcf('cloudflare.toolbox.tabs.cidr')}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={tcf('cloudflare.toolbox.cidr_input')} className="min-w-0 flex-1" required>
          <Input value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" />
        </Field>
        <Button icon={<Search size={14} />} disabled={!value.trim()} onClick={run}>{tcf('cloudflare.toolbox.calculate')}</Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[length:var(--text-12)] text-[var(--danger)]">{error}</p> : null}
      {result ? (
        <dl className={cn('mt-3 grid grid-cols-1 gap-3 text-[length:var(--text-12-5)] sm:grid-cols-2')}>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.cidr_network')}</dt><dd className="font-mono">{result.network}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.cidr_version')}</dt><dd>{tcf('cloudflare.toolbox.cidr_ip_version', { version: result.version })}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.cidr_first')}</dt><dd className="break-all font-mono">{result.first}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.cidr_last')}</dt><dd className="break-all font-mono">{result.last}</dd></div>
          {result.broadcast ? <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.cidr_broadcast')}</dt><dd className="font-mono">{result.broadcast}</dd></div> : null}
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.cidr_addresses')}</dt><dd>{result.addressCount}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.toolbox.cidr_usable')}</dt><dd>{result.usableHosts}</dd></div>
        </dl>
      ) : null}
      {!error && !result ? <PanelEmpty>{tcf('cloudflare.toolbox.cidr_empty')}</PanelEmpty> : null}
    </Panel>
  )
}

export function ToolboxScreen() {
  const tcf = useCfT()
  const [tab, setTab] = useState<ToolboxTab>('dns')

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {tcf('cloudflare.toolbox.title')}
        </h1>
      </header>
      <div className="flex flex-wrap gap-1">
        {TABS.map((item) => (
          <Button key={item.value} size="sm" variant={tab === item.value ? 'primary' : 'secondary'} onClick={() => setTab(item.value)}>
            {tcf(item.labelKey)}
          </Button>
        ))}
      </div>
      {tab === 'dns' ? <DnsPanel /> : null}
      {tab === 'rdap' ? <RdapPanel /> : null}
      {tab === 'probe' ? <ProbePanel /> : null}
      {tab === 'trace' ? <TracePanel /> : null}
      {tab === 'cidr' ? <CidrPanel /> : null}
    </div>
  )
}
