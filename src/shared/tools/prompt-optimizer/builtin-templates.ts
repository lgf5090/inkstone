/**
 * The built-in prompt templates, ported verbatim from the reference project.
 *
 * The reference stores them as TypeScript modules under
 * `packages/core/src/services/template/default-templates`. They are data, not code, so each template
 * family lives in its own JSON file under `./builtin/`; a reviewer diffs one family at a time instead
 * of scrolling a one-megabyte line, and the module below only concatenates them.
 *
 * Copyright (C) 2025 linshenkx (prompt-optimizer, AGPL-3.0-only); see NOTICE.
 */

import type { PromptTemplate } from './types'
import optimize from './builtin/optimize.json'
import contextIterate from './builtin/context-iterate.json'
import conversationMessageOptimize from './builtin/conversation-message-optimize.json'
import contextUserOptimize from './builtin/context-user-optimize.json'
import userOptimize from './builtin/user-optimize.json'
import iterate from './builtin/iterate.json'
import text2imageOptimize from './builtin/text2image-optimize.json'
import image2imageOptimize from './builtin/image2image-optimize.json'
import multiimageOptimize from './builtin/multiimage-optimize.json'
import imageIterate from './builtin/image-iterate.json'
import evaluation from './builtin/evaluation.json'
import variableExtraction from './builtin/variable-extraction.json'
import variableValueGeneration from './builtin/variable-value-generation.json'
import imagePromptComposition from './builtin/image-prompt-composition.json'
import imagePromptMigration from './builtin/image-prompt-migration.json'

export const BUILTIN_TEMPLATES: readonly PromptTemplate[] = Object.values({
  ...optimize,
  ...contextIterate,
  ...conversationMessageOptimize,
  ...contextUserOptimize,
  ...userOptimize,
  ...iterate,
  ...text2imageOptimize,
  ...image2imageOptimize,
  ...multiimageOptimize,
  ...imageIterate,
  ...evaluation,
  ...variableExtraction,
  ...variableValueGeneration,
  ...imagePromptComposition,
  ...imagePromptMigration,
} as unknown as Record<string, PromptTemplate>)
