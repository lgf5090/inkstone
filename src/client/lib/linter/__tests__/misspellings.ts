/**
 * The default correction table, loaded as source text.
 *
 * The app fetches this file at run time; a test cannot, so the same bytes arrive through Vite's raw
 * import and go through the same parser the fetch path uses.
 */
import table from '../../../../../public/linter/default-misspellings.md?raw';
import { parseCorrectionTable } from '../index';

export const defaultMisspellings = (): Map<string, string> => parseCorrectionTable(table);
