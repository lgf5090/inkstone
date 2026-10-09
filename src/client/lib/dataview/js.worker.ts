/**
 * The DML worker: a note's JavaScript, run where it cannot touch a page.
 *
 * The hardening is the runnable-example worker's — same shadowed names, same neutralised globals — and
 * the injection is the only extra door: `dv` plus the page snapshot. The code therefore has no element
 * to create, no `fetch`, no parent, and no way to answer a query the main thread did not already hand
 * over. What it produces is JSON: a list of descriptors the main thread draws.
 */

import { hardenWorkerScope, runUserCode } from '../../features/preview/js-runner-core'
import { createDv, type DvNode, type DvReply, type DvRequest } from './js-api'

interface WorkerScope {
    onmessage: ((event: MessageEvent<DvRequest>) => void) | null
    postMessage: (data: DvReply) => void
}

const scope = self as unknown as WorkerScope
const reply = scope.postMessage.bind(scope)

hardenWorkerScope(scope as unknown as Record<string, unknown>)

scope.onmessage = (event) => {
    const request = event.data
    const nodes: DvNode[] = []
    const outcome = runUserCode(request.code, {
        dv: createDv(request, (node) => {
            // A note that appends forever is stopped by the page-side timeout long before this cap,
            // but a loop that finishes can still ask for a hundred thousand nodes in one go.
            if (nodes.length < 5000) nodes.push(node)
        }),
    })
    reply({
        nodes,
        logs: outcome.logs,
        errorText: outcome.errorText,
        resultText: outcome.resultText,
        durationMs: outcome.durationMs,
        truncated: nodes.length >= 5000,
    })
}
