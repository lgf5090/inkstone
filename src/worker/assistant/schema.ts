/**
 * The chat assistant's tables.
 *
 * Everything the assistant owns is prefixed `chat_` and keyed by `(user_id, id)` rather than by
 * `id` alone. That is the one place the port had to depart from the reference project's schema: it
 * stored all of this in a Durable Object belonging to a single owner, so a bare `id TEXT PRIMARY KEY`
 * was enough — and here it is not. A global id key would let a backup restored into a second account
 * collide with the first one's row, and a write that quietly does nothing is the worst kind of data
 * loss, because every status code still says it worked.
 *
 * Every query in `store.ts` binds `user_id` for the same reason; the columns below are what makes that
 * filter indexable rather than a full scan.
 */

export const ASSISTANT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS chat_settings (
    user_id TEXT PRIMARY KEY,
    config TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS chat_providers (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    endpoints TEXT NOT NULL DEFAULT '{}',
    reasoning_dialect TEXT,
    key_ciphertext TEXT NOT NULL DEFAULT '',
    -- The last four characters of the stored key, so the settings row can prove which key it holds
    -- without the ciphertext ever being decrypted for a listing. Empty when no key is stored.
    key_hint TEXT NOT NULL DEFAULT '',
    key_last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_providers_user
     ON chat_providers(user_id, created_at)`,

  // The extra keys a provider may rotate through, beside the one on the provider's own row. A reader
  // with two accounts at one vendor gets both rate limits, and a key that starts failing can be switched
  // off without losing it. The ciphertext is the same vault material the provider's own key is.
  `CREATE TABLE IF NOT EXISTS chat_provider_keys (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    key_ciphertext TEXT NOT NULL DEFAULT '',
    key_hint TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_provider_keys_provider
     ON chat_provider_keys(user_id, provider_id, created_at)`,

  /**
   * The key the reader stores for one hosted web-search engine.
   *
   * It is its own table rather than a settings field because `chat_settings` is a plaintext JSON blob and a
   * search key is a credential: a settings row is read by every surface, written by a patch, and copied into
   * a backup file. Here the only thing that ever leaves is `key_hint`, the last four characters, which is the
   * same bargain `chat_provider_keys` makes — and this table is not in the backup's column list at all, so a
   * restored account has to type its key again rather than receive one it never sent.
   *
   * Keyed by `(user_id, engine)` instead of an id, because there is exactly one key per engine per reader:
   * a second one is not a second credential the vendor would honour, it is the same account, and replacing
   * it is an update on the row the engine names.
   */
  `CREATE TABLE IF NOT EXISTS chat_search_keys (
    user_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    key_ciphertext TEXT NOT NULL DEFAULT '',
    -- The last four characters of the stored key, so the settings screen can say which key it holds without
    -- the ciphertext ever being decrypted for a listing. Empty when no key is stored.
    key_hint TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, engine)
  )`,

  /**
   * The reader's own saved skills, the library behind the composer's `/` and ➕ entries.
   *
   * The table keeps the name it shipped under (`chat_prompts`, migration 48). A skill is what the row
   * always meant — the words plus the arrangement around them — so the product surface was renamed and
   * the storage name was not: renaming a table is not one of the two statements the migration ledger can
   * replay (`CREATE ... IF NOT EXISTS` and `ADD COLUMN`), and the boot creates the new name before the
   * ledger runs, so a rename migration could not tell a fresh database from one whose rows it had to
   * carry across. A wrong guess there is silent data loss, which is not worth the tidier noun.
   *
   * `group_name` rather than `group`: the latter is reserved in SQLite's own grammar, and a column that
   * needs quoting in every hand-written statement is a tax paid forever for a name saved once.
   *
   * The three binding columns turn a saved string into a standing arrangement: the words plus the tools
   * it wants, the note folders it reads, and the model that answers. They hold JSON ids rather than a
   * link table because a skill's whole point is to travel with the reader as one small object, and
   * nothing ever queries a skill *by* its tools. `icon` is the emoji it wears in the list, so a reader
   * with a dozen of them can find one by sight rather than by reading every title.
   */
  `CREATE TABLE IF NOT EXISTS chat_prompts (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    scopes TEXT NOT NULL DEFAULT '[]',
    model_id TEXT,
    icon TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_prompts_user
     ON chat_prompts(user_id, updated_at)`,

  `CREATE TABLE IF NOT EXISTS chat_models (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    temperature REAL,
    max_output_tokens INTEGER,
    reasoning TEXT NOT NULL DEFAULT 'auto',
    context_tokens INTEGER,
    vendor_context_tokens INTEGER,
    vendor_max_output_tokens INTEGER,
    vision INTEGER NOT NULL DEFAULT 1,
    purpose TEXT NOT NULL DEFAULT 'chat',
    kind TEXT NOT NULL DEFAULT 'text',
    supports_tools INTEGER NOT NULL DEFAULT 1,
    no_tools INTEGER NOT NULL DEFAULT 0,
    max_input_tokens INTEGER,
    modalities TEXT NOT NULL DEFAULT '[]',
    top_p REAL,
    custom_params TEXT NOT NULL DEFAULT '[]',
    protocol TEXT,
    fallback_model_id TEXT,
    input_price REAL,
    output_price REAL,
    price_currency TEXT NOT NULL DEFAULT '',
    price_periods TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    position REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_models_provider
     ON chat_models(user_id, provider_id, position)`,

  `CREATE TABLE IF NOT EXISTS chat_conversations (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT,
    summary_upto INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    ephemeral INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    folder_id TEXT,
    project_id TEXT,
    note_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conversations_user
     ON chat_conversations(user_id, updated_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conversations_folder
     ON chat_conversations(user_id, folder_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conversations_project
     ON chat_conversations(user_id, project_id, updated_at DESC)`,

  // The drafts a conversation keeps beside it: a reply the reader pulled into a panel to work on, rather
  // than one they would have had to edit in place and so rewrite the transcript. `note_id` is the note a
  // draft was saved to, written by the panel when the reader files it and cleared when they unlink it;
  // while it is set the two surfaces edit one document, so it is null only for a draft that is still
  // nothing but a draft.
  `CREATE TABLE IF NOT EXISTS chat_artifacts (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    note_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_artifacts_conversation
     ON chat_artifacts(user_id, conversation_id, updated_at DESC)`,

  // The versions a draft has been through.
  //
  // The artifact row is the head: its title and content are exactly the version its `version` number
  // names. A version row is immutable except for a manual edit, which updates the head version in place;
  // an assistant write and a restore both append a new version, so the history is never rewritten. That
  // is what makes it safe for a model to edit a draft: the previous text is always one row away.
  //
  // `source` says how the version came to exist, not what the reader later typed into it. `message_id`
  // points at the assistant turn that produced an assistant version so the history can say where it came
  // from; it is null for user edits, imports and restores.
  `CREATE TABLE IF NOT EXISTS chat_artifact_versions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user','assistant','restore','import')),
    message_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_artifact_versions_unique
     ON chat_artifact_versions(user_id, artifact_id, version)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_artifact_versions_conversation
     ON chat_artifact_versions(user_id, conversation_id, version DESC)`,

  // Which conversations have written which notes.
  //
  // The notebook's own backlink panel is built from `[[links]]` in note text, so a note the assistant
  // wrote has no backlinks at all — nothing points at it, because a conversation is not a note. This is
  // the other half of that panel: the notes a thread wrote, so the note can say where it came from and
  // the reader can go back to the exchange that produced it.
  //
  // One row per (note, conversation) rather than per write: a thread that appends to a note three times
  // is still one origin, and the panel is a list of threads, not of edits.
  `CREATE TABLE IF NOT EXISTS chat_note_writes (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, note_id, conversation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_note_writes_note
     ON chat_note_writes(user_id, note_id, created_at DESC)`,

  // The chat's own uploads: a pasted picture or a dropped document that feeds one turn. The key column
  // is the R2 object path, so deleting the row and deleting the object are the same operation.
  `CREATE TABLE IF NOT EXISTS chat_attachments (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL,
    key TEXT NOT NULL,
    extracted_text TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_attachments_user
     ON chat_attachments(user_id, created_at)`,

  // The join table mirrors note_tags: one row in tags, shared by whatever it labels.
  `CREATE TABLE IF NOT EXISTS chat_conversation_tags (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conversation_tags_tag
     ON chat_conversation_tags(user_id, tag_id)`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'complete',
    error TEXT,
    source TEXT NOT NULL DEFAULT 'chat',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    model_label TEXT NOT NULL DEFAULT '',
    feedback TEXT NOT NULL DEFAULT '',
    sources TEXT NOT NULL DEFAULT '[]',
    scopes TEXT NOT NULL DEFAULT '[]',
    -- The follow-up chips a naming pass volunteered for this answer, kept on the answer itself. A JSON array
    -- of at most three trimmed strings, [] when there are none — the same shape sources and scopes carry.
    -- NOT NULL with a default so a restore's INSERT OR IGNORE never drops a whole message over a missing
    -- key, exactly as every other array column here already does, and so a row written before the column and a
    -- row that got no suggestions read back identically.
    suggestions TEXT NOT NULL DEFAULT '[]',
    -- The answer the reader kept. Nullable rather than a flag with a default, because the state the column
    -- describes is "kept since when": the moment is what the saved list orders by and what a reader who
    -- comes back next month wants to see, and a flag would have to be joined to a timestamp anyway. NULL is
    -- every turn nobody kept, including every row that predates the column — the reading that loses nothing.
    saved_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
     ON chat_messages(user_id, conversation_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_user
     ON chat_messages(user_id, created_at)`,
  // The kept answers, newest kept first. Without this the list walks every turn the account has ever
  // stored to find the few dozen a reader pressed ⭐ on, and the account column leads so the walk starts
  // inside one tenant rather than across the table.
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_saved
     ON chat_messages(user_id, saved_at DESC, id)`,

  /**
   * The answers a retry displaced, one row each.
   *
   * The turn itself keeps a single `chat_messages` row and the reader pages through these. Storing the
   * model as text rather than as an id is deliberate: a version the reader can still open must survive
   * the model that produced it being deleted.
   */
  `CREATE TABLE IF NOT EXISTS chat_answer_versions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    model_label TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_answer_versions_message
     ON chat_answer_versions(user_id, message_id, created_at, id)`,

  /**
   * External MCP servers the reader added.
   *
   * The bearer header is stored encrypted, and only its length is ever selected: a listing that returned
   * the ciphertext would let a stolen backup be replayed against the third party.
   *
   * The two `oauth_` columns are the outbound half of the MCP authorization spec, split because the two
   * halves have different secrecy. The token, the client secret and the PKCE verifier go through the vault;
   * the discovered endpoints, the granted scopes and the expiry are plain, because the settings screen has
   * to say "authorized until Friday" for a whole list of servers without paying one decrypt per row.
   */
  `CREATE TABLE IF NOT EXISTS chat_mcp_servers (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    header_ciphertext TEXT NOT NULL DEFAULT '',
    oauth_ciphertext TEXT NOT NULL DEFAULT '',
    oauth_meta TEXT NOT NULL DEFAULT '{}',
    description TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL DEFAULT 'streamableHttp',
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    tool_mode TEXT NOT NULL DEFAULT 'ask',
    tool_modes TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_mcp_servers_user
     ON chat_mcp_servers(user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS chat_memories (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT,
    valid_from TEXT,
    valid_until TEXT,
    project_id TEXT,
    note_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_memories_user_updated
     ON chat_memories(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_memories_status
     ON chat_memories(user_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_memories_superseded
     ON chat_memories(user_id, superseded_by)`,
  // Which facts were written out of which page. The note's own backlink panel asks this — "what does the
  // assistant remember about this page?" — and it is the only memory read that does not arrive through a
  // project, a status or the account's whole list, so without this index the answer is a walk over every
  // fact the reader has saved.
  `CREATE INDEX IF NOT EXISTS idx_chat_memories_note
     ON chat_memories(user_id, note_id, updated_at DESC)`,

  // One embedding per memory, in the same blob layout as ai_note_embeddings so the app's own
  // encoder and cosine helpers are the only implementation of either.
  `CREATE TABLE IF NOT EXISTS chat_memory_embeddings (
    user_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    norm REAL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, memory_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_memory_embeddings_user
     ON chat_memory_embeddings(user_id, updated_at)`,

  `CREATE TABLE IF NOT EXISTS chat_memory_reviews (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    other_id TEXT NOT NULL,
    relationship TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_reviews_memory
     ON chat_memory_reviews(user_id, memory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_reviews_other
     ON chat_memory_reviews(user_id, other_id)`,

  `CREATE TABLE IF NOT EXISTS chat_tasks (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    due_at INTEGER,
    project_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_tasks_user_status_due
     ON chat_tasks(user_id, status, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_tasks_project
     ON chat_tasks(user_id, project_id)`,

  `CREATE TABLE IF NOT EXISTS chat_projects (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    note_scope TEXT NOT NULL DEFAULT '[]',
    note_ids TEXT NOT NULL DEFAULT '[]',
    model_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_projects_unique
     ON chat_projects(user_id, lower(name))`,

  `CREATE TABLE IF NOT EXISTS chat_automations (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'scheduled',
    next_run INTEGER,
    last_run INTEGER,
    last_result TEXT,
    last_error TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    target_folder_id TEXT,
    target_note_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_automations_due
     ON chat_automations(enabled, next_run)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_automations_user
     ON chat_automations(user_id, enabled, next_run)`,

  `CREATE TABLE IF NOT EXISTS chat_runs (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    automation_name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    note_id TEXT,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_runs_started
     ON chat_runs(user_id, started_at DESC)`,

  /**
   * What a routine delivered, and whether any device was ever told about it.
   *
   * `read_at` is the reader's own state and `pushed_at` is a delivery fact, and the two must not be
   * confused: the marker is stamped by `assistant/push-fanout.ts` the first time a push service accepts the
   * nudge for this row, and it is what makes a later cron catch-up fire idempotent. Null means "no device
   * ever accepted one" — including every row written before Web Push existed, which is the honest reading
   * rather than a backfill that would claim a send that never happened.
   */
  `CREATE TABLE IF NOT EXISTS chat_notifications (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    automation_id TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL,
    pushed_at INTEGER,
    subscription_id TEXT,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_notifications_user
     ON chat_notifications(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_notifications_unread
     ON chat_notifications(user_id, read_at, created_at)`,
  // The rows a catch-up fire is looking for: never nudged, newest first, one account at a time. Partial on
  // purpose — a deployment keeps every notification it ever delivered, and the ones already marked are not
  // candidates for anything, so they do not belong in the index the cron reads three times an hour.
  `CREATE INDEX IF NOT EXISTS idx_chat_notifications_unpushed
     ON chat_notifications(user_id, created_at) WHERE pushed_at IS NULL`,

  /**
   * The devices a reader has asked to be notified on.
   *
   * A row is a credential, not a preference. `endpoint` plus `p256dh` plus `auth` is everything needed to
   * put a notification on that machine, and whoever holds the triple holds it for as long as the row lives.
   * Three consequences are therefore fixed here and belong to any change to this table:
   *  - it is deliberately absent from `EXPORT_COLUMNS`, from `exportTables()` and from the backup reader, so
   *    no JSON export, share path or off-site snapshot ever carries it: a backup handed to another machine
   *    must not hand over the right to notify this one. A device's subscriptions are re-established by that
   *    device calling `PushManager.subscribe` again, which is the only renewal that is safe to rely on;
   *  - the triple never reaches a log line whole. `last_error` is written by the sender with a redacted
   *    description of the endpoint (origin plus a short digest), not with the endpoint itself;
   *  - the row is scoped and keyed by account like everything else here, and the delete paths are as
   *    careful as the read paths, because dropping another account's row would be denial plus a leak.
   */
  `CREATE TABLE IF NOT EXISTS chat_push_subscriptions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (user_id, id)
  )`,
  // One endpoint per account, once: a browser that renews its keys calls `subscribe` again at the same URL,
  // and the store upserts against this index rather than stacking a second credential for one device. It
  // leads with the account because every read here is one reader's device list.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_push_subscriptions_endpoint
     ON chat_push_subscriptions(user_id, endpoint)`,

  `CREATE TABLE IF NOT EXISTS chat_pending_actions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_label TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    resolved_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_actions_conversation
     ON chat_pending_actions(user_id, conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_actions_pending
     ON chat_pending_actions(user_id, status, expires_at)`,

  `CREATE TABLE IF NOT EXISTS chat_usage_daily (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    scheduled_runs INTEGER NOT NULL DEFAULT 0,
    embeddings INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`,

  // The same counters as `chat_usage_daily`, split by the model that answered. A day's total answers
  // "how much did I use"; this answers "which model, and what did it cost", which is the question a
  // reader with two providers and two prices actually has. Label is what the transcript shows and what
  // survives a model row being deleted; `model_id` rides beside it so a rename does not detach the cost
  // history, because a price resolved by id outlives the word the model was filed under. It is null for a
  // row whose label no longer names exactly one model — a guessed id would bill one model for another's.
  `CREATE TABLE IF NOT EXISTS chat_usage_daily_model (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    model_label TEXT NOT NULL,
    model_id TEXT,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, model_label)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_usage_model_user
     ON chat_usage_daily_model(user_id, day DESC)`,

  // The same counters a third time, split by the provider and key that answered as well as the model.
  // The model table cannot answer "which key spent this" — a provider with two keys on one model would
  // collide on its primary key — and the reader who is rotating keys is asking exactly that. The model
  // label rides along so a key-scoped view can still show which models that key paid for. Labels are
  // stored beside ids because a label is what the transcript shows and what survives a row being renamed
  // or deleted; `key_id` stays empty until a provider carries more than one key.
  `CREATE TABLE IF NOT EXISTS chat_usage_daily_key (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    model_label TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    provider_label TEXT NOT NULL DEFAULT '',
    key_id TEXT NOT NULL DEFAULT '',
    key_label TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, model_label, provider_id, key_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_usage_key_user
     ON chat_usage_daily_key(user_id, day DESC)`,

  // The tokens a time-of-day price applies to, filed under the window that was in force when the turn
  // was recorded. It is a sidecar rather than a dimension on the two tables above: their primary keys
  // predate pricing windows, and a table with the same day and model split by a window keeps the
  // existing totals — and every quota read — exactly as they were. Tokens written before this table
  // existed, or outside every window, have no row here and are priced at the base rate.
  //
  // The provider and key ride along so the key dimension stays priced too; an empty pair is a turn that
  // never resolved a key, which counts toward its model and toward no key, the same reading the key
  // table itself makes. Labels are absent because the key row already carries them.
  `CREATE TABLE IF NOT EXISTS chat_usage_daily_period (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    model_label TEXT NOT NULL,
    model_id TEXT,
    period_id TEXT NOT NULL,
    provider_id TEXT NOT NULL DEFAULT '',
    key_id TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, model_label, period_id, provider_id, key_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_usage_period_user
     ON chat_usage_daily_period(user_id, day DESC)`,

  // One published conversation behind an unguessable slug. Its own table rather than a row in the notes
  // app's `shares`: that one is keyed by note and joined to `notes` everywhere, and a shared thread has
  // neither a note id nor a note title. The passcode hash, the expiry and the view count mean the same
  // thing in both, which is why the code that reads them is shared and only the table is not.
  //
  // `scope` is what the link publishes: the empty string for the whole thread, otherwise the picked
  // message ids in a canonical order. It is a column rather than a second table because everything else
  // about the link — the slug, the passcode, the expiry, the view count — means the same thing whichever
  // part of the thread it points at, and a reader who narrows a link should not be handed a second set of
  // rules for it. It is part of the key so that one thread can have a link for the whole of it and links
  // for particular exchanges at the same time, without either one overwriting the other.
  `CREATE TABLE IF NOT EXISTS chat_share_links (
    slug TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    expires_at INTEGER,
    views INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_share_links_scope
     ON chat_share_links(user_id, conversation_id, scope)`,

  `CREATE TABLE IF NOT EXISTS chat_activity (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_activity_user
     ON chat_activity(user_id, created_at DESC)`,

  /**
   * One turn's claim on one conversation, and the words it had written when it last renewed.
   *
   * `lease_until` is the conversation's lock: a second tab is refused while it is in the future, and it is
   * renewed only from inside the running request, so a turn nobody is watching ages out on its own.
   * `started_at` is the token the claim was made under, and the only thing that can tell a turn's own lease
   * from one a second run has taken over.
   *
   * `partial_text` exists because those two facts were not enough on their own. A Worker isolate killed by
   * its CPU limit takes the request with it, and the answer is written to `chat_messages` at the end of a
   * turn, so the half that was already streamed had no row to live on — while this row went on holding the
   * conversation for the rest of `RUN_LEASE_MS`. It is carried here instead, by the renewal the turn already
   * makes, at a length ceiling (`RUN_PARTIAL_MAX_CHARS` in `@shared/assistant`) rather than in full.
   *
   * Nullable on purpose: NULL is a turn that has not written anything yet, which is not the same claim as
   * one that wrote an empty string. It is also not an archive — see the note on `EXPORT_COLUMNS` in
   * `store.ts`, which says why this row and its fragment never reach a backup. Reading it back is scoped by
   * `user_id` like every other query here, because the fragment is the account's own content.
   */
  `CREATE TABLE IF NOT EXISTS chat_active_runs (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL,
    partial_text TEXT,
    PRIMARY KEY (user_id, conversation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_active_runs_user
     ON chat_active_runs(user_id, lease_until)`,
]

export const ASSISTANT_REQUIRED_TABLES: readonly string[] = [
  'chat_settings',
  'chat_providers',
  'chat_models',
  'chat_conversations',
  'chat_artifacts',
  'chat_note_writes',
  'chat_attachments',
  'chat_conversation_tags',
  'chat_messages',
  'chat_memories',
  'chat_memory_embeddings',
  'chat_memory_reviews',
  'chat_tasks',
  'chat_projects',
  'chat_automations',
  'chat_runs',
  'chat_notifications',
  'chat_push_subscriptions',
  'chat_pending_actions',
  'chat_usage_daily',
  'chat_usage_daily_model',
  'chat_usage_daily_key',
  'chat_usage_daily_period',
  'chat_provider_keys',
  'chat_search_keys',
  'chat_share_links',
  'chat_activity',
  'chat_active_runs',
]

export const ASSISTANT_REQUIRED_INDEXES: readonly string[] = [
  'idx_chat_providers_user',
  'idx_chat_models_provider',
  'idx_chat_conversations_user',
  'idx_chat_conversations_folder',
  'idx_chat_conversations_project',
  'idx_chat_artifacts_conversation',
  'idx_chat_artifact_versions_unique',
  'idx_chat_artifact_versions_conversation',
  'idx_chat_note_writes_note',
  'idx_chat_attachments_user',
  'idx_chat_conversation_tags_tag',
  'idx_chat_messages_conversation',
  'idx_chat_messages_user',
  'idx_chat_messages_saved',
  'idx_chat_memories_user_updated',
  'idx_chat_memories_status',
  'idx_chat_memories_superseded',
  'idx_chat_memories_note',
  'idx_chat_memory_embeddings_user',
  'idx_chat_reviews_memory',
  'idx_chat_reviews_other',
  'idx_chat_tasks_user_status_due',
  'idx_chat_tasks_project',
  'idx_chat_projects_unique',
  'idx_chat_automations_due',
  'idx_chat_automations_user',
  'idx_chat_runs_started',
  'idx_chat_notifications_user',
  'idx_chat_notifications_unread',
  'idx_chat_notifications_unpushed',
  'idx_chat_push_subscriptions_endpoint',
  'idx_chat_actions_conversation',
  'idx_chat_actions_pending',
  'idx_chat_usage_model_user',
  'idx_chat_usage_key_user',
  'idx_chat_usage_period_user',
  'idx_chat_provider_keys_provider',
  'idx_chat_share_links_scope',
  'idx_chat_activity_user',
  'idx_chat_active_runs_user',
  'idx_chat_prompts_user',
  'idx_chat_answer_versions_message',
  'idx_chat_mcp_servers_user',
]

export const ASSISTANT_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  chat_settings: ['user_id', 'config', 'updated_at'],
  chat_projects: ['user_id', 'id', 'name', 'description', 'instructions', 'note_scope', 'note_ids', 'model_id', 'created_at', 'updated_at'],
  chat_usage_daily_model: ['user_id', 'day', 'model_label', 'model_id', 'requests', 'input_tokens', 'output_tokens', 'tool_calls', 'errors'],
  chat_usage_daily_key: ['user_id', 'day', 'model_label', 'provider_id', 'provider_label', 'key_id', 'key_label', 'requests', 'input_tokens', 'output_tokens', 'tool_calls', 'errors'],
  chat_usage_daily_period: ['user_id', 'day', 'model_label', 'model_id', 'period_id', 'provider_id', 'key_id', 'input_tokens', 'output_tokens'],
  chat_share_links: ['slug', 'conversation_id', 'user_id', 'scope', 'password_hash', 'expires_at', 'views', 'created_at'],
  chat_providers: ['user_id', 'id', 'label', 'icon', 'protocol', 'base_url', 'endpoints', 'reasoning_dialect', 'key_ciphertext', 'key_hint', 'key_last_used_at', 'created_at', 'updated_at'],
  chat_provider_keys: ['user_id', 'id', 'provider_id', 'label', 'key_ciphertext', 'key_hint', 'enabled', 'last_used_at', 'error_count', 'last_error', 'created_at', 'updated_at'],
  chat_search_keys: ['user_id', 'engine', 'key_ciphertext', 'key_hint', 'created_at', 'updated_at'],
  chat_models: ['user_id', 'id', 'provider_id', 'model', 'label', 'icon', 'temperature', 'max_output_tokens', 'reasoning', 'context_tokens',
    'vendor_context_tokens', 'vendor_max_output_tokens', 'vision',
    'purpose', 'kind', 'supports_tools', 'no_tools', 'max_input_tokens', 'modalities', 'top_p', 'custom_params', 'protocol', 'fallback_model_id',
    'input_price', 'output_price', 'price_currency', 'price_periods', 'enabled', 'position'],
  chat_conversations: ['user_id', 'id', 'title', 'summary', 'summary_upto', 'pinned', 'starred', 'archived', 'ephemeral', 'parent_id', 'folder_id', 'project_id', 'note_id', 'created_at', 'updated_at'],
  chat_artifacts: ['user_id', 'id', 'conversation_id', 'title', 'content', 'note_id', 'version', 'created_at', 'updated_at'],
  chat_artifact_versions: ['user_id', 'id', 'artifact_id', 'conversation_id', 'version', 'title', 'content', 'source', 'message_id', 'created_at'],
  chat_note_writes: ['user_id', 'note_id', 'conversation_id', 'created_at'],
  chat_attachments: ['user_id', 'id', 'kind', 'filename', 'mime', 'size', 'key', 'extracted_text', 'created_at'],
  chat_conversation_tags: ['user_id', 'conversation_id', 'tag_id', 'created_at'],
  chat_messages: ['user_id', 'id', 'conversation_id', 'role', 'content', 'reasoning', 'tools', 'attachments', 'status', 'error', 'source', 'input_tokens', 'output_tokens', 'duration_ms', 'model_label', 'feedback', 'sources', 'scopes', 'suggestions', 'saved_at', 'created_at'],
  chat_answer_versions: ['user_id', 'id', 'message_id', 'conversation_id', 'content', 'reasoning', 'tools', 'model_label', 'input_tokens', 'output_tokens', 'duration_ms', 'created_at'],
  chat_mcp_servers: ['user_id', 'id', 'label', 'url', 'description', 'transport', 'timeout_seconds', 'header_ciphertext', 'oauth_ciphertext', 'oauth_meta', 'enabled', 'tool_mode', 'tool_modes', 'created_at', 'updated_at'],
  chat_memories: ['user_id', 'id', 'content', 'category', 'source', 'status', 'superseded_by', 'valid_from', 'valid_until', 'project_id', 'note_id', 'created_at', 'updated_at'],
  chat_memory_embeddings: ['user_id', 'memory_id', 'model', 'vector', 'norm', 'updated_at'],
  chat_memory_reviews: ['user_id', 'id', 'memory_id', 'other_id', 'relationship', 'reason', 'created_at'],
  chat_tasks: ['user_id', 'id', 'title', 'description', 'status', 'priority', 'due_at', 'project_id', 'created_at', 'updated_at', 'completed_at'],
  chat_automations: ['user_id', 'id', 'name', 'kind', 'message', 'schedule', 'enabled', 'status', 'next_run', 'last_run', 'last_result', 'last_error', 'run_count', 'claimed_at', 'target_folder_id', 'target_note_id', 'created_at', 'updated_at'],
  chat_runs: ['user_id', 'id', 'automation_id', 'automation_name', 'started_at', 'finished_at', 'status', 'result', 'error', 'note_id'],
  chat_notifications: ['user_id', 'id', 'title', 'body', 'automation_id', 'read_at', 'created_at', 'pushed_at', 'subscription_id'],
  chat_push_subscriptions: ['user_id', 'id', 'endpoint', 'p256dh', 'auth', 'created_at', 'failures', 'last_error'],
  chat_pending_actions: ['user_id', 'id', 'conversation_id', 'tool', 'target_id', 'target_label', 'args', 'status', 'error', 'created_at', 'expires_at', 'resolved_at'],
  chat_usage_daily: ['user_id', 'day', 'requests', 'input_tokens', 'output_tokens', 'tool_calls', 'scheduled_runs', 'embeddings', 'errors'],
  chat_activity: ['user_id', 'id', 'type', 'summary', 'created_at'],
  chat_active_runs: ['user_id', 'conversation_id', 'started_at', 'lease_until', 'partial_text'],
  chat_prompts: ['user_id', 'id', 'title', 'content', 'group_name', 'tools', 'scopes', 'model_id', 'icon', 'created_at', 'updated_at'],
}
