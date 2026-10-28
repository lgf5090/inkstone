import { useMemo, useState } from 'react'
import type { CollectionNode, ResponseResult, TestResult } from '@shared/development/api-tester/types'
import { useApiTesterStore } from '../store'
import { activeVariables } from '../lib/variables'
import { cancelActiveRequest } from '../send'
import { SplitPane } from '../../../../components/split-pane'
import { Tabs } from '../../../../components/tabs'
import { t } from '../../../../lib/i18n'
import { RequestBuilder } from './RequestBuilder'
import { ResponsePanel } from './ResponsePanel'
import { WebSocketPanel } from './WebSocketPanel'

export function WorkspaceView({
  node,
  result,
  loading,
  testResults,
  onSend,
  compact,
}: {
  node: CollectionNode
  result: ResponseResult | null
  loading: boolean
  testResults?: { results: TestResult[]; error?: string }
  onSend: () => void
  compact: boolean
}) {
  const state = useApiTesterStore((s) => s.state)
  const updateNode = useApiTesterStore((s) => s.updateNode)
  const [mode, setMode] = useState<'request' | 'response'>('request')
  const [ratio, setRatio] = useState(0.5)
  const variables = useMemo(() => activeVariables(state), [state])
  const kind = node.kind ?? 'rest'
  const onChange = (patch: Partial<CollectionNode>) => updateNode(node.id, patch)

  if (kind === 'websocket') {
    return <WebSocketPanel node={node} onChange={onChange} />
  }

  const request = (
    <RequestBuilder
      node={node}
      tags={state.tags}
      variables={variables}
      loading={loading}
      onCancel={cancelActiveRequest}
      onChange={onChange}
      onSend={onSend}
    />
  )
  const response = (
    <ResponsePanel
      result={result}
      loading={loading}
      request={node.request ?? null}
      kind={kind}
      testResults={testResults}
      autoPrettify={state.settings.autoPrettify}
    />
  )

  if (compact) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-[var(--border-subtle)] p-1">
          <Tabs
            value={mode}
            onChange={setMode}
            label={t('development.apitester.request')}
            items={[
              { id: 'request' as const, label: t('development.apitester.request') },
              { id: 'response' as const, label: `${t('development.apitester.response')}${result ? ` · ${result.status || '…'}` : ''}` },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1">{mode === 'request' ? request : response}</div>
      </div>
    )
  }

  return (
    <SplitPane
      orientation={state.settings.splitDirection === 'horizontal' ? 'horizontal' : 'vertical'}
      ratio={ratio}
      onChange={setRatio}
      label={t('development.apitester.workspace_split')}
      first={request}
      second={response}
    />
  )
}
