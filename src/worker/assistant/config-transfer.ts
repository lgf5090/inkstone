import {
  ASSISTANT_MODEL_KINDS,
  ASSISTANT_MODEL_PURPOSES,
  ASSISTANT_PROTOCOLS,
  normalizeAssistantSettings,
  parseCustomParams,
  type AssistantModel,
  type AssistantModelKind,
  type AssistantModelModality,
  type AssistantModelPurpose,
  type AssistantProtocol,
  type AssistantSettings,
  type AssistantSkill,
  type AssistantToolMode,
  type Project,
} from '@shared/assistant'
import type { AssistantStore } from './store'

export const ASSISTANT_CONFIG_FORMAT = 'inkstone-assistant-config'
export const ASSISTANT_CONFIG_VERSION = 1

/** Settings that name a row or a decision local to the exporting account. */
const LOCAL_ONLY_SETTINGS = ['activeModelId', 'limits', 'offlineMode'] as const

export interface AssistantConfigProvider {
  id: string
  label: string
  icon: string
  protocol: AssistantProtocol
  baseUrl: string
  endpoints: Record<string, string>
  reasoningDialect: string | null
}

export interface AssistantConfigModel {
  id: string
  providerId: string
  model: string
  label: string
  icon: string
  temperature: number | null
  maxOutputTokens: number | null
  reasoning: string
  contextTokens: number | null
  vision: boolean
  purpose: string
  kind: string
  supportsTools: boolean
  noTools: boolean
  maxInputTokens: number | null
  topP: number | null
  modalities: string[]
  customParams: unknown[]
  protocol: AssistantProtocol | null
  enabled: boolean
}

export interface AssistantConfigBundle {
  format: typeof ASSISTANT_CONFIG_FORMAT
  version: number
  exportedAt: number
  settings: Omit<AssistantSettings, (typeof LOCAL_ONLY_SETTINGS)[number]>
  providers: AssistantConfigProvider[]
  models: AssistantConfigModel[]
  skills: Array<Pick<AssistantSkill, 'title' | 'content' | 'group' | 'icon' | 'tools' | 'scopes' | 'modelId'>>
  projects: Array<Pick<Project, 'name' | 'description' | 'icon' | 'instructions' | 'noteScope' | 'excludeScope' | 'noteIds' | 'modelId' | 'tools' | 'toolsLimited' | 'toolOverrides' | 'skillIds' | 'focusSync' | 'timeAware' | 'readProjectInstructions' | 'position'>>
}

export interface ConfigImportSummary {
  settings: boolean
  providers: number
  models: number
  skills: number
  projects: number
  /** Rows whose identity already existed here. */
  skipped: number
}

/**
 * The portable half of an account.
 *
 * No provider key, key hint or search key is present: a config file moves what the reader configured,
 * not what proves they may use it. A restored provider therefore starts with no key, and the settings
 * screen says so until the reader types one.
 */
export async function exportAssistantConfig(store: AssistantStore): Promise<AssistantConfigBundle> {
  const [settings, providers, models, skills, projects] = await Promise.all([
    store.getSettings(),
    store.listProviders(),
    store.listModels(),
    store.listSkills({ limit: 500 }),
    store.listProjects(),
  ])
  const portable = { ...settings } as Record<string, unknown>
  for (const key of LOCAL_ONLY_SETTINGS) delete portable[key]
  return {
    format: ASSISTANT_CONFIG_FORMAT,
    version: ASSISTANT_CONFIG_VERSION,
    exportedAt: Date.now(),
    settings: portable as AssistantConfigBundle['settings'],
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      icon: provider.icon,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      endpoints: provider.endpoints,
      reasoningDialect: provider.reasoningDialect,
    })),
    models: models.map((model) => ({
      id: model.id,
      providerId: model.providerId,
      model: model.model,
      label: model.label,
      icon: model.icon,
      temperature: model.temperature,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning,
      contextTokens: model.contextTokens,
      vision: model.vision,
      purpose: model.purpose,
      kind: model.kind,
      supportsTools: model.supportsTools !== false,
      noTools: model.noTools === true,
      maxInputTokens: model.maxInputTokens,
      topP: model.topP,
      modalities: model.modalities,
      customParams: model.customParams,
      protocol: model.protocol,
      enabled: model.enabled,
    })),
    skills: skills.map((skill) => ({
      title: skill.title,
      content: skill.content,
      group: skill.group,
      icon: skill.icon,
      tools: skill.tools,
      scopes: skill.scopes,
      modelId: skill.modelId,
    })),
    projects: projects.map((project) => ({
      name: project.name,
      description: project.description,
      icon: project.icon ?? '',
      instructions: project.instructions ?? '',
      noteScope: project.noteScope ?? [],
      excludeScope: project.excludeScope ?? [],
      noteIds: project.noteIds ?? [],
      modelId: project.modelId ?? null,
      tools: project.tools ?? [],
      toolsLimited: project.toolsLimited === true,
      toolOverrides: project.toolOverrides ?? {},
      skillIds: project.skillIds ?? [],
      focusSync: project.focusSync !== false,
      timeAware: project.timeAware !== false,
      readProjectInstructions: project.readProjectInstructions === true,
      position: project.position ?? 0,
    })),
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)) : []
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function stringList(value: unknown, max: number, itemMax = 120): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim().slice(0, itemMax)).filter(Boolean).slice(0, max)
    : []
}

function numberOrNull(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
}

/**
 * Merges a config file into this account.
 *
 * Identity is what makes this safe to repeat: a provider is the same one when its label and address
 * match, a model when the provider and model id do, a skill or Agent when its title or name does. A row
 * that already exists here is left alone rather than overwritten, so importing a file cannot roll back a
 * setting the reader changed after exporting it.
 */
export async function importAssistantConfig(store: AssistantStore, raw: Record<string, unknown>): Promise<ConfigImportSummary> {
  if (raw.format !== ASSISTANT_CONFIG_FORMAT) throw new Error('That is not an Inkstone assistant config file.')
  const version = typeof raw.version === 'number' ? Math.trunc(raw.version) : 1
  if (version > ASSISTANT_CONFIG_VERSION) throw new Error(`Unsupported config version ${version}.`)
  const data = record(raw)
  const summary: ConfigImportSummary = { settings: false, providers: 0, models: 0, skills: 0, projects: 0, skipped: 0 }

  if (data.settings && typeof data.settings === 'object') {
    const current = await store.getSettings()
    const incoming = normalizeAssistantSettings(data.settings)
    const merged: AssistantSettings = {
      ...incoming,
      activeModelId: current.activeModelId,
      limits: current.limits,
      offlineMode: current.offlineMode,
    }
    await store.saveSettings(merged)
    summary.settings = true
  }

  const [existingProviders, existingModels, existingSkills, existingProjects] = await Promise.all([
    store.listProviders(),
    store.listModels(),
    store.listSkills({ limit: 500 }),
    store.listProjects(),
  ])
  const providerKey = (label: string, baseUrl: string): string => `${label.toLocaleLowerCase()}\n${baseUrl}`
  const providerIds = new Map(existingProviders.map((provider) => [providerKey(provider.label, provider.baseUrl), provider.id]))
  const modelIds = new Map<string, string>()
  const oldModelIds = new Map<string, string>()
  for (const model of existingModels) {
    modelIds.set(`${model.providerId}\n${model.model}`, model.id)
    oldModelIds.set(model.id, model.id)
  }

  for (const entry of list(data.providers).slice(0, 100)) {
    const label = text(entry.label, 60)
    const baseUrl = text(entry.baseUrl, 400)
    const protocol = text(entry.protocol, 40) as AssistantProtocol
    if (!label || !baseUrl || !(ASSISTANT_PROTOCOLS as readonly string[]).includes(protocol)) { summary.skipped++; continue }
    const key = providerKey(label, baseUrl)
    const existing = providerIds.get(key)
    if (existing) { providerIds.set(`old:${text(entry.id, 64)}`, existing); summary.skipped++; continue }
    const created = await store.createProvider({
      label,
      icon: text(entry.icon, 40),
      protocol,
      baseUrl,
      apiKey: '',
      endpoints: record(entry.endpoints) as Partial<Record<AssistantProtocol, string>>,
      reasoningDialect: (text(entry.reasoningDialect, 40) || null) as never,
    })
    providerIds.set(key, created.id)
    providerIds.set(`old:${text(entry.id, 64)}`, created.id)
    summary.providers++
  }

  for (const entry of list(data.models).slice(0, 300)) {
    const providerId = providerIds.get(`old:${text(entry.providerId, 64)}`)
    const model = text(entry.model, 120)
    if (!providerId || !model) { summary.skipped++; continue }
    const key = `${providerId}\n${model}`
    if (modelIds.has(key)) {
      const existing = existingModels.find((entry) => entry.providerId === providerId && entry.model === model)
      if (existing) oldModelIds.set(text(entry.id, 64), existing.id)
      summary.skipped++
      continue
    }
    const created = await store.createModel({
      providerId,
      model,
      label: text(entry.label, 120) || model,
      icon: text(entry.icon, 40),
      temperature: numberOrNull(entry.temperature, 0, 1.5),
      maxOutputTokens: numberOrNull(entry.maxOutputTokens, 1, 1_000_000),
      reasoning: (text(entry.reasoning, 30) || 'auto') as AssistantModel['reasoning'],
      contextTokens: numberOrNull(entry.contextTokens, 1_000, 2_000_000),
      vision: entry.vision !== false,
      protocol: (ASSISTANT_PROTOCOLS as readonly string[]).includes(text(entry.protocol, 40)) ? text(entry.protocol, 40) as AssistantProtocol : null,
    })
    const purpose = text(entry.purpose, 30) as AssistantModelPurpose
    const kind = text(entry.kind, 30) as AssistantModelKind
    await store.updateModel(created.id, {
      purpose: (ASSISTANT_MODEL_PURPOSES as readonly string[]).includes(purpose) ? purpose : 'chat',
      kind: (ASSISTANT_MODEL_KINDS as readonly string[]).includes(kind) ? kind : 'text',
      supportsTools: entry.supportsTools !== false,
      noTools: entry.noTools === true,
      maxInputTokens: numberOrNull(entry.maxInputTokens, 1_000, 2_000_000),
      topP: numberOrNull(entry.topP, 0, 1),
      modalities: stringList(entry.modalities, 10, 30) as AssistantModelModality[],
      customParams: parseCustomParams(entry.customParams),
      enabled: entry.enabled !== false,
    })
    modelIds.set(key, created.id)
    oldModelIds.set(text(entry.id, 64), created.id)
    summary.models++
  }

  const skillIds = new Map<string, string>()
  const skillsByTitle = new Map(existingSkills.map((skill) => [skill.title.toLocaleLowerCase(), skill.id]))
  for (const entry of list(data.skills).slice(0, 300)) {
    const title = text(entry.title, 200)
    const content = text(entry.content, 20_000)
    if (!title || !content) { summary.skipped++; continue }
    if (skillsByTitle.has(title.toLocaleLowerCase())) { summary.skipped++; continue }
    const created = await store.insertSkill({
      title,
      content,
      group: text(entry.group, 80),
      icon: text(entry.icon, 40),
      tools: stringList(entry.tools, 50),
      scopes: [],
      modelId: oldModelIds.get(text(entry.modelId, 64)) ?? null,
    })
    skillsByTitle.set(title.toLocaleLowerCase(), created.id)
    skillIds.set(text(entry.title, 200), created.id)
    summary.skills++
  }

  const projectNames = new Set(existingProjects.map((project) => project.name.toLocaleLowerCase()))
  for (const entry of list(data.projects).slice(0, 200)) {
    const name = text(entry.name, 120)
    if (!name || projectNames.has(name.toLocaleLowerCase())) { summary.skipped++; continue }
    const modelId = text(entry.modelId, 64)
    const resolvedModel = modelId ? oldModelIds.get(modelId) ?? null : null
    const toolOverrides: Record<string, AssistantToolMode> = {}
    for (const [tool, mode] of Object.entries(record(entry.toolOverrides))) {
      if (mode === 'auto' || mode === 'ask' || mode === 'off') toolOverrides[tool.slice(0, 120)] = mode
    }
    await store.createProject({
      name,
      description: text(entry.description, 2_000),
      icon: text(entry.icon, 40),
      instructions: text(entry.instructions, 8_000),
      noteScope: stringList(entry.noteScope, 100),
      excludeScope: stringList(entry.excludeScope, 100),
      noteIds: stringList(entry.noteIds, 100, 64),
      modelId: resolvedModel,
      tools: stringList(entry.tools, 100),
      toolsLimited: entry.toolsLimited === true,
      toolOverrides,
      skillIds: stringList(entry.skillIds, 100).map((id) => skillIds.get(id) ?? '').filter(Boolean),
      focusSync: entry.focusSync !== false,
      timeAware: entry.timeAware !== false,
      readProjectInstructions: entry.readProjectInstructions === true,
      position: numberOrNull(entry.position, 0, 1_000_000) ?? 0,
    })
    projectNames.add(name.toLocaleLowerCase())
    summary.projects++
  }

  return summary
}
