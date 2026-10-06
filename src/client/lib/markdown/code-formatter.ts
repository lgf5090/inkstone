import type { MessageKey } from '../i18n';
import type { FormatFailure } from './code-formatter/index';

export { formatCode, formatCodeResult, CODE_FORMAT_LIMIT_BYTES, type FormatResult, type FormatOptions, type FormatFailure } from './code-formatter/index';
export type { SqlKeywordCase } from './code-formatter/sql';

/** Why a press wrote nothing, in the words the author can act on. */
export const CODE_FORMAT_FAILURE_MESSAGES: Record<FormatFailure, MessageKey> = {
  empty: 'preview.code_format_empty',
  'too-large': 'preview.code_format_too_large',
  unchanged: 'preview.code_format_unchanged',
  failed: 'preview.code_format_failed',
};
