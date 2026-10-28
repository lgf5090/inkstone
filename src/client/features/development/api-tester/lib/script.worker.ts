import { executeScript } from './script-vm'
import type { ScriptContext } from '@shared/development/api-tester/types'

interface WorkerRequest {
  id: number
  mode: 'pre' | 'tests'
  script: string
  context: ScriptContext
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, mode, script, context } = event.data
  void executeScript({ script, mode, context })
    .then((result) => self.postMessage({ id, result }))
    .catch((error: unknown) => self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }))
}
