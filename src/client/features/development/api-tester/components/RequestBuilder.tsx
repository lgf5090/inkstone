import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, File as FileIcon, Loader2, Play, Tag as TagIcon, Upload, Variable as VariableIcon, X } from 'lucide-react'
import { MAX_FILE_BYTES } from '@shared/development/api-tester/limits'
import { defaultRequest } from '@shared/development/api-tester/state'
import {
  HTTP_METHODS,
  type BodyType,
  type CollectionNode,
  type HttpMethod,
  type HttpRequestConfig,
  type TagNode,
} from '@shared/development/api-tester/types'
import { Checkbox, Input, Select, Textarea } from '../../../../components/form'
import { Menu, useClickOutside, useEscape, type MenuItem } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { Tabs } from '../../../../components/tabs'
import { cn } from '../../../../lib/cn'
import { t, type MessageKey } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { formatBytes } from '../../../../lib/time'
import { parseCurl } from '../lib/curl-parser'
import { tagColorValue } from '../lib/tag-colors'
import { collectVarNames, tagPath, type Variable } from '../lib/variables'
import { deleteFile, errorMessage, uploadFile } from '../api'
import { AuthEditor } from './AuthEditor'
import { KvEditor } from './KvEditor'
import { VariableAutocomplete } from './VariableAutocomplete'

type RequestTab = 'params' | 'headers' | 'auth' | 'body' | 'preScript' | 'tests' | 'desc' | 'query' | 'variables'

const REST_TABS: readonly RequestTab[] = ['params', 'headers', 'auth', 'body', 'preScript', 'tests', 'desc']
const GRAPHQL_TABS: readonly RequestTab[] = ['query', 'variables', 'headers', 'auth', 'preScript', 'tests', 'desc']

const BODY_TYPES: ReadonlyArray<{ value: BodyType; labelKey: MessageKey }> = [
  { value: 'none', labelKey: 'development.apitester.body_none' },
  { value: 'json', labelKey: 'development.apitester.body_json' },
  { value: 'form-urlencoded', labelKey: 'development.apitester.body_form_urlencoded' },
  { value: 'form-data', labelKey: 'development.apitester.body_form_data' },
  { value: 'raw', labelKey: 'development.apitester.body_raw' },
  { value: 'binary', labelKey: 'development.apitester.body_binary' },
]

const METHOD_TONE: Record<HttpMethod, string> = {
  GET: 'text-[var(--success)]',
  POST: 'text-[var(--warning)]',
  PUT: 'text-[var(--accent)]',
  PATCH: 'text-[var(--chart-5)]',
  DELETE: 'text-[var(--danger)]',
  HEAD: 'text-[var(--text-tertiary)]',
  OPTIONS: 'text-[var(--text-tertiary)]',
}

export interface RequestBuilderProps {
  node: CollectionNode
  tags: TagNode[]
  variables: Variable[]
  loading: boolean
  onCancel?: () => void
  onChange: (patch: Partial<CollectionNode>) => void
  onSend: () => void
  autoFocusName?: boolean
  onNameFocusDone?: () => void
}

export function RequestBuilder({
  node,
  tags,
  variables,
  loading,
  onCancel,
  onChange,
  onSend,
  autoFocusName,
  onNameFocusDone,
}: RequestBuilderProps) {
  const request = node.request ?? defaultRequest()
  const kind = node.kind ?? 'rest'
  const isGraphql = kind === 'graphql'
  const fallbackTab: RequestTab = isGraphql ? 'query' : 'params'
  const tabs = isGraphql ? GRAPHQL_TABS : REST_TABS

  const panelId = useId()
  const tagPanelId = useId()
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const tagTriggerRef = useRef<HTMLButtonElement | null>(null)
  const tagPanelRef = useRef<HTMLDivElement | null>(null)
  const methodTriggerRef = useRef<HTMLButtonElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const focusedNameFor = useRef<string | null>(null)
  const nodeRef = useRef(node)
  const onChangeRef = useRef(onChange)

  const [tab, setTab] = useState<RequestTab>(fallbackTab)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [methodOpen, setMethodOpen] = useState(false)
  const [curlWarnings, setCurlWarnings] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  useEffect(() => {
    nodeRef.current = node
    onChangeRef.current = onChange
  })

  useEffect(() => {
    if (!autoFocusName || focusedNameFor.current === node.id) return
    const input = nameInputRef.current
    if (!input) return
    focusedNameFor.current = node.id
    input.focus()
    input.select()
    onNameFocusDone?.()
  }, [autoFocusName, node.id, onNameFocusDone])

  useEffect(() => {
    setCurlWarnings([])
    setUploadError(null)
  }, [node.id])

  const activeTab = tabs.includes(tab) ? tab : fallbackTab

  const closeTags = () => setTagsOpen(false)
  const closeTagsWithFocus = () => {
    setTagsOpen(false)
    tagTriggerRef.current?.focus()
  }
  useClickOutside([tagTriggerRef, tagPanelRef], tagsOpen, closeTags)
  useEscape(tagsOpen, closeTagsWithFocus)

  const update = (patch: Partial<HttpRequestConfig>) => onChange({ request: { ...request, ...patch } })

  const missingVars = useMemo(() => {
    const defined = new Set(variables.map((variable) => variable.key))
    const names = new Set<string>()
    const texts = [
      request.url,
      request.body,
      request.graphqlQuery,
      request.graphqlVariables,
      ...request.headers.map((header) => header.key + header.value),
      ...request.params.map((param) => param.key + param.value),
      ...request.formFields.map((field) => field.key + field.value),
    ]
    for (const text of texts) {
      for (const name of collectVarNames(text)) {
        if (!defined.has(name)) names.add(name)
      }
    }
    return [...names]
  }, [request, variables])

  const changeUrl = (url: string) => {
    if (curlWarnings.length > 0) setCurlWarnings([])
    update({ url })
  }

  const handlePaste = (event: React.ClipboardEvent) => {
    if (request.url) return
    const pasted = event.clipboardData?.getData('text') ?? ''
    const trimmed = pasted.trim()
    if (!/^curl(\.exe)?\s/i.test(trimmed)) return
    event.preventDefault()
    try {
      const parsed = parseCurl(trimmed)
      update({
        url: parsed.request.url,
        method: parsed.request.method,
        headers: parsed.request.headers,
        params: parsed.request.params,
        bodyType: parsed.request.bodyType,
        body: parsed.request.body,
        formFields: parsed.request.formFields,
        auth: parsed.request.auth,
      })
      setCurlWarnings(parsed.warnings.map((warning) => warning.flag ?? warning.code))
    } catch (error) {
      console.warn('[inkstone] API Tester cURL paste fell back to the URL', error)
      update({ url: pasted })
    }
  }

  const handleUrlKeyDown = (event: React.KeyboardEvent) => {
    // The module-level Cmd/Ctrl+Enter handler owns the modified key, so this answers the bare key only.
    if (event.metaKey || event.ctrlKey) return
    if (event.key !== 'Enter' || loading || !request.url || isImeComposing(event)) return
    event.preventDefault()
    onSend()
  }

  const toggleTag = (tagId: string) => {
    onChange({
      tags: node.tags.includes(tagId) ? node.tags.filter((id) => id !== tagId) : [...node.tags, tagId],
    })
  }

  const removeFile = () => {
    const previousId = request.bodyFileId
    setUploadError(null)
    update({ bodyFileId: undefined, bodyFileName: undefined, bodyFileSize: undefined })
    if (previousId) {
      void deleteFile(previousId).catch((error) => {
        console.warn('[inkstone] API Tester body file could not be deleted', error)
      })
    }
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const target = event.target
    const file = target.files?.[0]
    target.value = ''
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setUploadError(t('api.error.payload_too_large'))
      return
    }
    const nodeId = node.id
    const previousId = request.bodyFileId
    setUploadError(null)
    setUploading(true)
    try {
      const uploaded = await uploadFile(file, file.type.startsWith('image/') ? 'image' : 'bin', file.name)
      if (nodeRef.current.id !== nodeId) {
        void deleteFile(uploaded.id).catch((error) => {
          console.warn('[inkstone] API Tester orphaned body file could not be deleted', error)
        })
        return
      }
      const current = nodeRef.current.request ?? defaultRequest()
      onChangeRef.current({
        request: {
          ...current,
          body: '',
          bodyFileId: uploaded.id,
          bodyFileName: uploaded.name,
          bodyFileSize: uploaded.size,
        },
      })
      if (previousId && previousId !== uploaded.id) {
        void deleteFile(previousId).catch((error) => {
          console.warn('[inkstone] API Tester previous body file could not be deleted', error)
        })
      }
    } catch (error) {
      setUploadError(errorMessage(error))
    } finally {
      setUploading(false)
    }
  }

  const methodItems: MenuItem[] = HTTP_METHODS.map((method) => ({
    id: method,
    label: method,
    checked: method === request.method,
    icon: <span aria-hidden="true" className={cn('size-1.5 rounded-full bg-current', METHOD_TONE[method])} />,
    onSelect: () => update({ method }),
  }))

  const tabItems = tabs.map((id) => {
    if (id === 'params') {
      const count = request.params.filter((param) => param.key).length
      return { id, label: count > 0 ? `${t('development.apitester.params')} (${count})` : t('development.apitester.params') }
    }
    if (id === 'headers') {
      const count = request.headers.filter((header) => header.key).length
      return { id, label: count > 0 ? `${t('development.apitester.headers')} (${count})` : t('development.apitester.headers') }
    }
    if (id === 'auth') return { id, label: t('development.apitester.auth') }
    if (id === 'body') return { id, label: t('development.apitester.body') }
    if (id === 'preScript') return { id, label: t('development.apitester.pre_script') }
    if (id === 'tests') return { id, label: t('development.apitester.tests') }
    if (id === 'query') return { id, label: t('development.apitester.query') }
    if (id === 'variables') return { id, label: t('development.apitester.variables') }
    return { id, label: t('development.apitester.desc') }
  })

  const hasFile = Boolean(request.bodyFileId || request.bodyFileName)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <Input
          ref={nameInputRef}
          value={node.name}
          placeholder={t('development.apitester.request_name_placeholder')}
          aria-label={t('development.apitester.request_name')}
          className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-0 text-[length:var(--text-13)] font-medium focus:border-transparent focus:shadow-none"
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <div className="relative shrink-0">
          <Button
            ref={tagTriggerRef}
            variant="secondary"
            size="sm"
            aria-haspopup="true"
            aria-expanded={tagsOpen}
            aria-controls={tagsOpen ? tagPanelId : undefined}
            icon={<TagIcon size={13} />}
            onClick={() => setTagsOpen((open) => !open)}
          >
            {node.tags.length > 0
              ? t('development.apitester.tags_selected', { count: node.tags.length })
              : t('development.apitester.tags')}
          </Button>
          {tagsOpen && (
            <div
              id={tagPanelId}
              ref={tagPanelRef}
              role="group"
              aria-label={t('development.apitester.tags')}
              className="absolute top-full right-0 z-[var(--z-popover)] mt-1 max-h-72 w-64 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]"
            >
              {tags.length === 0 ? (
                <p className="px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t('development.apitester.no_tags_hint')}
                </p>
              ) : (
                tags.map((tag) => {
                  const path = tagPath(tags, tag.id)
                  return (
                    <div
                      key={tag.id}
                      className="flex items-center gap-1.5 rounded-[var(--r-sm)] px-1 hover:bg-[var(--bg-hover)]"
                    >
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: tagColorValue(tag.color) ?? undefined }}
                      />
                      <Checkbox
                        checked={node.tags.includes(tag.id)}
                        onChange={() => toggleTag(tag.id)}
                        ariaLabel={path}
                        label={<span className="truncate">{path}</span>}
                        className="min-w-0 flex-1"
                      />
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-3 py-2">
        {!isGraphql && (
          <div className="relative shrink-0">
            <button
              ref={methodTriggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={methodOpen}
              aria-label={`${t('development.apitester.request')} ${request.method}`}
              onClick={() => setMethodOpen((open) => !open)}
              className="inline-flex h-8 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 hover:border-[var(--border-strong)]"
            >
              <span className={cn('font-mono text-[length:var(--text-12)] font-semibold', METHOD_TONE[request.method])}>
                {request.method}
              </span>
              <ChevronDown size={12} aria-hidden="true" className="text-[var(--text-quaternary)]" />
            </button>
            <Menu
              anchor={methodTriggerRef}
              open={methodOpen}
              onClose={() => setMethodOpen(false)}
              items={methodItems}
              width={160}
              label={t('development.apitester.request')}
            />
          </div>
        )}
        <VariableAutocomplete
          value={request.url}
          variables={variables}
          placeholder={t(isGraphql ? 'development.apitester.graphql_url_placeholder' : 'development.apitester.url_placeholder')}
          ariaLabel={t(isGraphql ? 'development.apitester.query' : 'development.apitester.request')}
          wrapperClassName="min-w-0 flex-1"
          className="h-8 font-mono text-[length:var(--text-12)]"
          onValueChange={changeUrl}
          onPaste={handlePaste}
          onKeyDown={handleUrlKeyDown}
        />
        {loading ? (
          <Button
            variant="danger"
            size="sm"
            className="shrink-0"
            disabled={!onCancel}
            icon={<Loader2 size={13} className="animate-spin" />}
            onClick={onCancel}
          >
            {t('development.apitester.cancel')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            className="shrink-0"
            disabled={!request.url}
            icon={<Play size={13} />}
            onClick={onSend}
          >
            {t(isGraphql ? 'development.apitester.query' : 'development.apitester.send')}
          </Button>
        )}
      </div>

      {(variables.length > 0 || missingVars.length > 0 || curlWarnings.length > 0) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-1">
          <VariableIcon size={12} aria-hidden="true" className="text-[var(--text-quaternary)]" />
          {variables.length > 0 && (
            <Badge tone="neutral">{t('development.apitester.env_vars', { count: variables.length })}</Badge>
          )}
          {missingVars.map((name) => (
            <Badge key={name} tone="warning">
              {t('development.apitester.undefined_var', { name })}
            </Badge>
          ))}
          {curlWarnings.map((warning, index) => (
            <Badge key={`${warning}-${index}`} tone="warning">
              {warning}
            </Badge>
          ))}
        </div>
      )}

      <div className="shrink-0 border-b border-[var(--border-subtle)] px-2 py-1">
        <Tabs value={activeTab} onChange={setTab} items={tabItems} label={t('development.apitester.request')} panelId={panelId} />
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${activeTab}`}
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        {activeTab === 'params' && (
          <KvEditor items={request.params} variables={variables} onChange={(params) => update({ params })} />
        )}

        {activeTab === 'headers' && (
          <KvEditor items={request.headers} variables={variables} onChange={(headers) => update({ headers })} />
        )}

        {activeTab === 'auth' && (
          <AuthEditor auth={request.auth} variables={variables} onChange={(auth) => update({ auth })} />
        )}

        {activeTab === 'query' && (
          <VariableAutocomplete
            multiline
            value={request.graphqlQuery}
            variables={variables}
            placeholder={t('development.apitester.query_placeholder')}
            ariaLabel={t('development.apitester.query')}
            className="min-h-[260px] resize-y font-mono text-[length:var(--text-12)]"
            onValueChange={(graphqlQuery) => update({ graphqlQuery })}
          />
        )}

        {activeTab === 'variables' && (
          <VariableAutocomplete
            multiline
            value={request.graphqlVariables}
            variables={variables}
            placeholder={t('development.apitester.variables_placeholder')}
            ariaLabel={t('development.apitester.variables')}
            className="min-h-[260px] resize-y font-mono text-[length:var(--text-12)]"
            onValueChange={(graphqlVariables) => update({ graphqlVariables })}
          />
        )}

        {activeTab === 'body' && (
          <div className="space-y-2">
            <Select
              aria-label={t('development.apitester.body')}
              value={request.bodyType}
              className="h-8 w-52 text-[length:var(--text-12)]"
              onChange={(event) => update({ bodyType: event.target.value as BodyType })}
            >
              {BODY_TYPES.map((body) => (
                <option key={body.value} value={body.value}>
                  {t(body.labelKey)}
                </option>
              ))}
            </Select>

            {request.bodyType === 'none' && (
              <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {t('development.apitester.no_body_hint')}
              </p>
            )}

            {(request.bodyType === 'json' || request.bodyType === 'raw') && (
              <VariableAutocomplete
                multiline
                value={request.body}
                variables={variables}
                placeholder={t(
                  request.bodyType === 'json'
                    ? 'development.apitester.json_body_placeholder'
                    : 'development.apitester.raw_body_placeholder',
                )}
                ariaLabel={t(
                  request.bodyType === 'json'
                    ? 'development.apitester.body_json'
                    : 'development.apitester.body_raw',
                )}
                className="min-h-[220px] resize-y font-mono text-[length:var(--text-12)]"
                onValueChange={(body) => update({ body })}
              />
            )}

            {(request.bodyType === 'form-urlencoded' || request.bodyType === 'form-data') && (
              <KvEditor
                items={request.formFields}
                variables={variables}
                keyPlaceholder={t('development.apitester.field_name')}
                valuePlaceholder={t('development.apitester.field_value')}
                onChange={(formFields) => update({ formFields })}
              />
            )}

            {request.bodyType === 'binary' && (
              <div className="space-y-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="sr-only"
                  tabIndex={-1}
                  aria-label={t('development.apitester.choose_file')}
                  onChange={(event) => void handleFileChange(event)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Upload size={13} />}
                    loading={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t('development.apitester.choose_file')}
                  </Button>
                  {hasFile && (
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] px-2 py-1.5 text-[length:var(--text-12)]">
                      <FileIcon size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {request.bodyFileName ?? t('development.apitester.file_selected')}
                      </span>
                      {typeof request.bodyFileSize === 'number' && (
                        <span className="shrink-0 text-[var(--text-tertiary)]">{formatBytes(request.bodyFileSize)}</span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-[var(--danger)]"
                        icon={<X size={12} />}
                        onClick={removeFile}
                      >
                        {t('development.apitester.remove_file')}
                      </Button>
                    </div>
                  )}
                </div>
                {!hasFile && (
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {t('development.apitester.binary_hint')}
                  </p>
                )}
                {uploadError && (
                  <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">
                    {uploadError}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'preScript' && (
          <div className="space-y-2">
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.apitester.pre_script_hint')}
            </p>
            <Textarea
              value={node.preScript ?? ''}
              placeholder={t('development.apitester.pre_script_placeholder')}
              aria-label={t('development.apitester.pre_script')}
              spellCheck={false}
              className="min-h-[220px] resize-y font-mono text-[length:var(--text-12)]"
              onChange={(event) => onChange({ preScript: event.target.value })}
            />
          </div>
        )}

        {activeTab === 'tests' && (
          <div className="space-y-2">
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.apitester.tests_hint')}
            </p>
            <Textarea
              value={node.tests ?? ''}
              placeholder={t('development.apitester.tests_placeholder')}
              aria-label={t('development.apitester.tests')}
              spellCheck={false}
              className="min-h-[220px] resize-y font-mono text-[length:var(--text-12)]"
              onChange={(event) => onChange({ tests: event.target.value })}
            />
          </div>
        )}

        {activeTab === 'desc' && (
          <div className="space-y-2">
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.apitester.desc_hint')}
            </p>
            <Textarea
              value={node.description ?? ''}
              placeholder={t('development.apitester.desc_placeholder')}
              aria-label={t('development.apitester.desc')}
              spellCheck={false}
              className="min-h-[220px] resize-y font-mono text-[length:var(--text-12)]"
              onChange={(event) => onChange({ description: event.target.value })}
            />
          </div>
        )}
      </div>
    </div>
  )
}
