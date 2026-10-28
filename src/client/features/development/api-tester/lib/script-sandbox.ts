import { executeScript, type ScriptVmResult } from './script-vm'
import type { ScriptContext, TestResult } from '@shared/development/api-tester/types'

interface WorkerRequest {
  id: number
  mode: 'pre' | 'tests'
  script: string
  context: ScriptContext
}

interface WorkerReply {
  id: number
  result?: ScriptVmResult
  error?: string
}

let worker: Worker | null = null
let sequence = 0
const pending = new Map<number, { resolve: (value: ScriptVmResult) => void; reject: (error: Error) => void; timer: number }>()

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (worker) return worker
  worker = new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    window.clearTimeout(entry.timer)
    if (event.data.error) entry.reject(new Error(event.data.error))
    else if (event.data.result) entry.resolve(event.data.result)
    else entry.reject(new Error('The script sandbox returned no result'))
  }
  worker.onerror = (event) => {
    const error = new Error(event.message || 'The script sandbox failed')
    for (const [id, entry] of pending) {
      window.clearTimeout(entry.timer)
      entry.reject(error)
      pending.delete(id)
    }
  }
  return worker
}

async function run(mode: 'pre' | 'tests', script: string, context: ScriptContext): Promise<ScriptVmResult> {
  const target = ensureWorker()
  if (!target) return executeScript({ script, mode, context })
  const id = ++sequence
  return new Promise<ScriptVmResult>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error('The script timed out'))
    }, 3_000)
    pending.set(id, { resolve, reject, timer })
    target.postMessage({ id, mode, script, context } satisfies WorkerRequest)
  })
}

export interface PreScriptResult {
  headers?: ScriptContext['request']['headers']
  params?: ScriptContext['request']['params']
  variables: Record<string, string>
  env: Record<string, string>
  error?: string
}

export interface TestsResult {
  results: TestResult[]
  env: Record<string, string>
  error?: string
}

export async function runPreScript(script: string, context: ScriptContext): Promise<PreScriptResult> {
  if (!script.trim()) return { variables: context.variables, env: context.environment }
  const result = await run('pre', script, context)
  return { headers: result.headers, params: result.params, variables: result.variables, env: result.env, error: result.error }
}

export async function runTests(script: string, context: ScriptContext): Promise<TestsResult> {
  if (!script.trim()) return { results: [], env: context.environment }
  const result = await run('tests', script, context)
  return { results: result.tests, env: result.env, error: result.error }
}
