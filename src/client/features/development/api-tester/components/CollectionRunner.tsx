import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Play, Square, XCircle } from 'lucide-react'
import type { CollectionNode, ResponseResult, TestResult } from '@shared/development/api-tester/types'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Checkbox } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { executeRequest } from '../lib/relay-client'
import { runPreScript, runTests } from '../lib/script-sandbox'
import { activeVariables, variableRecord } from '../lib/variables'
import { useApiTesterStore } from '../store'

interface Row {
  nodeId: string
  name: string
  method: string
  url: string
  status: number
  durationMs: number
  error?: string
  tests?: { results: TestResult[]; error?: string }
  state: 'pending' | 'running' | 'done' | 'skipped'
}

function collectRequests(nodes: CollectionNode[], folderId: string | null): CollectionNode[] {
  const out: CollectionNode[] = []
  const walk = (parentId: string | null) => {
    for (const node of nodes.filter((entry) => entry.parentId === parentId).sort((left, right) => left.order - right.order)) {
      if (node.type === 'request' && node.kind !== 'websocket' && node.request) out.push(node)
      else if (node.type === 'folder') walk(node.id)
    }
  }
  walk(folderId)
  return out
}

export function CollectionRunner({ open, onClose, folder }: { open: boolean; onClose: () => void; folder: CollectionNode | null }) {
  const nodes = useApiTesterStore((s) => s.state.nodes)
  const state = useApiTesterStore((s) => s.state)
  const requests = useMemo(() => (folder ? collectRequests(nodes, folder.id) : []), [folder, nodes])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState<Row[]>([])
  const [running, setRunning] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(-1)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    setSelected(new Set(requests.map((request) => request.id)))
    setRows([])
    setRunning(false)
    setCurrentIndex(-1)
  }, [open, requests])

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const stop = () => {
    abortRef.current?.abort()
    setRunning(false)
    setCurrentIndex(-1)
    setRows((current) => current.map((row) => (row.state === 'pending' || row.state === 'running' ? { ...row, state: 'skipped' } : row)))
  }

  const run = async () => {
    const targets = requests.filter((request) => selected.has(request.id))
    if (targets.length === 0) return
    setRunning(true)
    setRows(requests.map((request) => ({
      nodeId: request.id,
      name: request.name,
      method: request.request?.method ?? 'GET',
      url: request.request?.url ?? '',
      status: 0,
      durationMs: 0,
      state: selected.has(request.id) ? 'pending' : 'skipped',
    })))
    const controller = new AbortController()
    abortRef.current = controller
    let environment = variableRecord(activeVariables(state))
    const patch = (id: string, value: Partial<Row>) => setRows((current) => current.map((row) => (row.nodeId === id ? { ...row, ...value } : row)))
    for (const [index, node] of targets.entries()) {
      if (controller.signal.aborted) break
      setCurrentIndex(index)
      patch(node.id, { state: 'running' })
      try {
        let request = node.request!
        let variables = activeVariables(state)
        if (node.preScript?.trim()) {
          const pre = await runPreScript(node.preScript, {
            environment,
            variables: { ...environment },
            request: { method: request.method, url: request.url, headers: request.headers, params: request.params, body: request.body },
            dynamic: { timestamp: Date.now(), uuid: crypto.randomUUID(), iso: new Date().toISOString() },
          })
          if (pre.error) {
            patch(node.id, { state: 'done', error: t('development.apitester.pre_script_error_short', { msg: pre.error }) })
            continue
          }
          request = { ...request, headers: pre.headers ?? request.headers, params: pre.params ?? request.params }
          environment = pre.env
          variables = [
            ...variables.filter((variable) => !(variable.key in pre.variables) && !(variable.key in pre.env)),
            ...Object.entries(pre.variables).map(([key, value]) => ({ key, value, enabled: true })),
            ...Object.entries(pre.env).map(([key, value]) => ({ key, value, enabled: true })),
          ]
        }
        const result: ResponseResult = await executeRequest(request, {
          variables,
          followRedirects: state.settings.followRedirects,
          timeoutMs: state.settings.timeoutMs,
          kind: (node.kind ?? 'rest') as 'rest' | 'graphql' | 'websocket',
          signal: controller.signal,
        })
        let tests: Row['tests']
        if (node.tests?.trim()) {
          const headers: Record<string, string> = {}
          for (const header of result.headers) headers[header.key] = header.value
          const outcome = await runTests(node.tests, {
            environment,
            variables: { ...environment },
            request: { method: request.method, url: request.url, headers: request.headers, params: request.params, body: request.body },
            response: {
              status: result.status,
              statusText: result.statusText,
              headers,
              body: result.body,
              durationMs: result.durationMs,
              sizeBytes: result.sizeBytes,
            },
            dynamic: { timestamp: Date.now(), uuid: crypto.randomUUID(), iso: new Date().toISOString() },
          })
          tests = outcome
          environment = outcome.env
        }
        patch(node.id, { state: 'done', status: result.status, durationMs: result.durationMs, error: result.error, tests })
      } catch (error) {
        patch(node.id, { state: 'done', error: error instanceof Error ? error.message : String(error) })
      }
    }
    setRunning(false)
    setCurrentIndex(-1)
  }

  const done = rows.filter((row) => row.state === 'done')
  const passed = done.filter((row) => row.status >= 200 && row.status < 400 && !row.error).length
  const failed = done.filter((row) => row.error || row.status === 0 || row.status >= 400).length
  const totalMs = done.reduce((sum, row) => sum + row.durationMs, 0)
  const byId = new Map(rows.map((row) => [row.nodeId, row]))

  return (
    <Modal open={open} onClose={onClose} title={`${t('development.apitester.runner_title')}${folder ? ` — ${folder.name}` : ''}`} description={t('development.apitester.runner_desc')} width={720}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] pb-2">
          <Checkbox
            checked={selected.size === requests.length && requests.length > 0}
            onChange={(next) => setSelected(next ? new Set(requests.map((request) => request.id)) : new Set())}
            ariaLabel={t('development.apitester.selected_count', { count: selected.size, total: requests.length })}
          />
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.selected_count', { count: selected.size, total: requests.length })}</span>
          <div className="flex-1" />
          {running ? (
            <Button size="sm" variant="danger" className="gap-1" onClick={stop}><Square size={12} /> {t('development.apitester.stop')}</Button>
          ) : (
            <Button size="sm" className="gap-1" disabled={selected.size === 0} onClick={() => void run()}><Play size={12} /> {t('development.apitester.run_selected', { count: selected.size })}</Button>
          )}
        </div>
        <div className="max-h-[50vh] min-h-[200px] overflow-y-auto overscroll-contain">
          {requests.length === 0 ? (
            <p className="py-12 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.apitester.no_executable')}</p>
          ) : (
            requests.map((node, index) => {
              const row = byId.get(node.id)
              return (
                <div key={node.id} className={cn('flex items-center gap-2 border-b border-[var(--border-subtle)] px-1 py-1.5 text-[length:var(--text-11-5)]', running && currentIndex === index && 'bg-[var(--accent-softer)]')}>
                  <Checkbox checked={selected.has(node.id)} disabled={running} onChange={() => toggle(node.id)} ariaLabel={node.name} />
                  <span className="flex w-4 shrink-0 justify-center">
                    {running && currentIndex === index ? <Loader2 size={13} className="animate-spin text-[var(--accent)]" /> : row?.state === 'done' ? (
                      row.error || row.status === 0 ? <XCircle size={13} className="text-[var(--danger)]" /> : row.status >= 400 ? <XCircle size={13} className="text-[var(--warning)]" /> : <CheckCircle2 size={13} className="text-[var(--success)]" />
                    ) : row?.state === 'skipped' ? <span className="text-[var(--text-quaternary)]">—</span> : null}
                  </span>
                  <span className="w-12 shrink-0 font-mono font-semibold text-[var(--text-secondary)]">{node.request?.method ?? 'GET'}</span>
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  {row?.tests && row.tests.results.length > 0 && <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.apitester.tests_passed_count', { passed: row.tests.results.filter((test) => test.passed).length, total: row.tests.results.length })}</span>}
                  {row?.state === 'done' && <span className="w-16 shrink-0 text-right font-mono text-[length:var(--text-10)] text-[var(--text-tertiary)]">{row.durationMs} {t('development.apitester.ms')}</span>}
                  {row?.error && <AlertCircle size={12} className="shrink-0 text-[var(--danger)]" />}
                </div>
              )
            })
          )}
        </div>
        {done.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)] pt-2 text-[length:var(--text-11)]">
            <span className="text-[var(--text-tertiary)]">{t('development.apitester.executed_count', { count: done.length })}</span>
            <span className="text-[var(--success)]">{t('development.apitester.passed_count', { count: passed })}</span>
            <span className="text-[var(--danger)]">{t('development.apitester.failed_count', { count: failed })}</span>
            <span className="text-[var(--text-tertiary)]">{t('development.apitester.total_duration', { ms: totalMs })}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
