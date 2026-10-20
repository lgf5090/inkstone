/**
 * The shapes a task line is made of.
 *
 * Kept apart from the serializer on purpose: these describe Markdown syntax, which is fixed, while
 * the emoji that follow the checkbox are a format the reader can swap out in settings.
 */
export const TaskRegularExpressions = {
  dateFormat: 'YYYY-MM-DD',
  dateTimeFormat: 'YYYY-MM-DD HH:mm',

  /** Indentation, including the `>` of a blockquote or a callout. */
  indentationRegex: /^([\s\t>]*)/,
  /** Bullet or ordered markers, so `1.` and `2)` are both list items. */
  listMarkerRegex: /([-*+]|[0-9]+[.)])/,
  /** A checkbox and the single status character inside it. */
  checkboxRegex: /\[(.)\]/u,
  /** Whatever follows the checkbox. */
  afterCheckboxRegex: / *(.*)/u,

  /** A line that is a task: marker, checkbox, body. */
  taskRegex: new RegExp(
    /^([\s\t>]*)/.source + /([-*+]|[0-9]+[.)])/.source + ' +' + /\[(.)\]/u.source + / *(.*)/u.source,
    'u',
  ),

  /** A line that may be made into a task, which is how "create or edit task" finds its anchor. */
  nonTaskRegex: new RegExp(
    /^([\s\t>]*)/.source + /([-*+]|[0-9]+[.)])/.source + '? *(' + /\[(.)\]/u.source + ')?' + / *(.*)/u.source,
    'u',
  ),

  /** A list item of any kind, task or not. */
  listItemRegex: new RegExp(/^([\s\t>]*)/.source + /([-*+]|[0-9]+[.)])/.source),

  /** A trailing block id, which survives a rewrite but is never part of the description. */
  blockLinkRegex: / \^[a-zA-Z0-9-]+$/u,

  /**
   * Hashtags. The leading `(^|\s)` is what keeps `http://example.com/a#b` from reading as tagged,
   * and the negated class is what keeps `#1.5`, `#tag)` and `#tag,` from over-reaching.
   */
  hashTags: /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g,
  hashTagsFromEnd: /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+$/,
} as const
