import { executeUserCode, hardenWorkerScope, type JsRunOutcome } from './js-runner-core'

interface WorkerScope {
  onmessage: ((event: MessageEvent<string>) => void) | null
  postMessage: (data: JsRunOutcome) => void
}

const scope = self as unknown as WorkerScope
const reply = scope.postMessage.bind(scope)

hardenWorkerScope(scope as unknown as Record<string, unknown>)

scope.onmessage = (event) => {
  reply(executeUserCode(event.data))
}
