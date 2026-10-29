/**
 * English copy for the CloudDrive owner console.
 *
 * Loaded on demand beside `en-US-clouddrive` so the file browser never carries the admin strings.
 * Every key keeps the `clouddrive.admin.` prefix, which cannot collide with the shell catalogue.
 */
export const EN_US_CLOUDDRIVE_ADMIN = {
  'clouddrive.admin.not_owner': 'Owner access required',
  'clouddrive.admin.not_owner_hint': 'This page is available to the workspace owner only.',
  'clouddrive.admin.no_data': 'No data yet',
  'clouddrive.admin.last_updated': 'Last updated',
  'clouddrive.admin.version': 'Version',
  'clouddrive.admin.environment': 'Environment',

  'clouddrive.admin.dashboard.storages': 'Storage configurations',
  'clouddrive.admin.dashboard.capacity_all': 'All storage',
  'clouddrive.admin.dashboard.used': 'Used',
  'clouddrive.admin.dashboard.quota': 'Quota',
  'clouddrive.admin.dashboard.no_quota': 'No quota',
  'clouddrive.admin.dashboard.type_distribution': 'Storage type distribution',
  'clouddrive.admin.dashboard.objects': '{count} objects',
  'clouddrive.admin.dashboard.cache': 'Cache monitor',
  'clouddrive.admin.dashboard.weekly_activity': 'Last 7 days',

  'clouddrive.admin.cache.entries': 'Entries',
  'clouddrive.admin.cache.hits': 'Hits',
  'clouddrive.admin.cache.misses': 'Misses',
  'clouddrive.admin.cache.snapshot': 'Snapshot',
  'clouddrive.admin.cache.isolate': 'Isolate snapshot',
  'clouddrive.admin.cache.isolate_hint': 'These counts cover the current Worker isolate only, not a global aggregate.',

  'clouddrive.admin.chart.uploads': 'Uploads',
  'clouddrive.admin.chart.bar': 'Bar chart',
  'clouddrive.admin.chart.line': 'Line chart',
  'clouddrive.admin.chart.no_activity': 'No activity this week',
  'clouddrive.admin.chart.label': 'Uploads and shares over the last 7 days',


  'clouddrive.admin.index.status.error': 'Error',
  'clouddrive.admin.index.external': 'External',

  'clouddrive.admin.preview.type.text': 'Text',
  'clouddrive.admin.preview.type.archive': 'Archive',

  'clouddrive.admin.jobs.status': 'Status',
  'clouddrive.admin.jobs.duration': 'Duration',
  'clouddrive.admin.jobs.error': 'Error',
  'clouddrive.admin.jobs.handler.cleanup_upload_sessions': 'Clean up expired upload sessions',
  'clouddrive.admin.jobs.handler.purge_share_sessions': 'Purge expired share sessions',
  'clouddrive.admin.jobs.handler.refresh_storage_usage': 'Refresh storage usage',
  'clouddrive.admin.jobs.status.success': 'Success',
} as const
