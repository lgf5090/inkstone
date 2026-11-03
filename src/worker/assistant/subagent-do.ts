import type { AssistantSettings } from '@shared/assistant'
import { normalizeAssistantSettings } from '@shared/assistant'
import type { Env } from '../env'
import { initializeDatabase } from '../db/schema'
import { AssistantStore } from './store'
import { AssistantRunner } from './runner'
import { ALL_TOOLS } from './tools'

/**
 * A child agent that outlives the request which asked for it.
 *
 * The HTTP turn writes a task row and hands the job to this object by the task id. The object keeps the
 * job in its own storage, runs it from an alarm (so a closed tab, a failed response or an isolate restart
 * does not lose it), and writes progress back to the same row. One object per task, so two alarms can
 * never run the same job twice.
 */
interface SubagentJob {
  userId: string
  taskId: string
  description: string
  prompt: string
  modelId: string | null
  parentConversationId: string
  origin: string
}

const JOB_KEY = 'job'
const CANCELLED_KEY = 'cancelled'

export class SubagentRunner implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/start') {
      return new Response('Unknown path', { status: 404 })
    }
    const body = await request.json().catch(() => null) as SubagentJob | null
    if (!body || !body.userId || !body.taskId || !body.prompt) return new Response('Invalid job', { status: 400 })
    await this.state.storage.put(JOB_KEY, body)
    await this.state.storage.delete(CANCELLED_KEY)
    await this.state.storage.setAlarm(Date.now() + 10)
    return Response.json({ accepted: true })
  }

  async alarm(): Promise<void> {
    const job = await this.state.storage.get<SubagentJob>(JOB_KEY)
    if (!job) return
    if (await this.state.storage.get<boolean>(CANCELLED_KEY)) {
      await this.state.storage.delete(JOB_KEY)
      return
    }
    const controller = new AbortController()
    const { ftsEnabled } = await initializeDatabase(this.env)
    const store = new AssistantStore(this.env.DB, job.userId, this.env)
    const settings: AssistantSettings = normalizeAssistantSettings(await store.getSettings())
    const runner = new AssistantRunner({ store, env: this.env, ftsEnabled, origin: job.origin, settings })
    const allowedTools = ALL_TOOLS
      .filter((definition) => definition.permission === 'read' && definition.name !== 'ask_user_question' && definition.name !== 'delegate_subagent')
      .map((definition) => definition.name)
    let text = ''
    let error: string | null = null
    let tokens = 0
    const toolIds = new Set<string>()
    let conversationId: string | null = null
    try {
      for await (const event of runner.chat({
        message: job.prompt,
        modelId: job.modelId,
        ephemeral: true,
        origin: 'subagent',
        signal: controller.signal,
        subagent: true,
        allowedTools,
      })) {
        if (event.type === 'start' && event.conversationId) conversationId = event.conversationId
        if (event.type === 'text') text += event.delta ?? ''
        if (event.type === 'tool' && event.tool) toolIds.add(event.tool.id)
        if (event.type === 'usage' && event.usage) tokens = event.usage.inputTokens + event.usage.outputTokens
        if (event.type === 'error') error = event.message ?? 'The sub-agent failed.'
        if (event.type === 'done' && event.finalMessage?.status === 'complete' && event.finalMessage.content) text = event.finalMessage.content
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The sub-agent failed.'
    } finally {
      await store.finishSubagentTask(job.taskId, {
        status: error ? (controller.signal.aborted ? 'cancelled' : 'error') : 'success',
        result: error ? null : text.slice(0, 20_000),
        error,
        toolCalls: toolIds.size,
        tokens,
      })
      if (conversationId) {
        await store.releaseRun(conversationId)
        await store.deleteConversation(conversationId)
      }
      await store.createNotification({
        title: job.description.slice(0, 200),
        body: error ? error.slice(0, 1_000) : (text.slice(0, 1_000) || 'The sub-agent finished without an answer.'),
      })
      await this.state.storage.delete(JOB_KEY)
    }
  }
}
