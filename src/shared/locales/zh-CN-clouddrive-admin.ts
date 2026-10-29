/**
 * Chinese copy for the CloudDrive owner console.
 *
 * Mirrors `en-US-clouddrive-admin.ts`; both are loaded on demand by the shell's i18n registry.
 */
export const ZH_CN_CLOUDDRIVE_ADMIN = {
  'clouddrive.admin.not_owner': '需要所有者权限',
  'clouddrive.admin.not_owner_hint': '此页面仅对工作区所有者开放。',
  'clouddrive.admin.no_data': '暂无数据',
  'clouddrive.admin.last_updated': '最后更新',
  'clouddrive.admin.version': '版本',
  'clouddrive.admin.environment': '运行环境',

  'clouddrive.admin.dashboard.storages': '存储配置',
  'clouddrive.admin.dashboard.capacity_all': '所有存储',
  'clouddrive.admin.dashboard.used': '已用',
  'clouddrive.admin.dashboard.quota': '配额',
  'clouddrive.admin.dashboard.no_quota': '无配额',
  'clouddrive.admin.dashboard.type_distribution': '存储类型分布',
  'clouddrive.admin.dashboard.objects': '{count} 个对象',
  'clouddrive.admin.dashboard.cache': '缓存监控',
  'clouddrive.admin.dashboard.weekly_activity': '最近 7 天',

  'clouddrive.admin.cache.entries': '条目',
  'clouddrive.admin.cache.hits': '命中',
  'clouddrive.admin.cache.misses': '未命中',
  'clouddrive.admin.cache.snapshot': '快照时间',
  'clouddrive.admin.cache.isolate': '本实例快照',
  'clouddrive.admin.cache.isolate_hint': '这些数字只覆盖当前 Worker 实例（isolate），不是全局聚合。',

  'clouddrive.admin.chart.uploads': '上传',
  'clouddrive.admin.chart.bar': '柱状图',
  'clouddrive.admin.chart.line': '折线图',
  'clouddrive.admin.chart.no_activity': '本周暂无活动',
  'clouddrive.admin.chart.label': '最近 7 天的上传与分享',


  'clouddrive.admin.index.status.error': '错误',
  'clouddrive.admin.index.external': '外部',

  'clouddrive.admin.preview.type.text': '文本',
  'clouddrive.admin.preview.type.archive': '压缩包',

  'clouddrive.admin.jobs.status': '状态',
  'clouddrive.admin.jobs.duration': '耗时',
  'clouddrive.admin.jobs.error': '错误',
  'clouddrive.admin.jobs.handler.cleanup_upload_sessions': '清理过期上传会话',
  'clouddrive.admin.jobs.handler.purge_share_sessions': '清理过期分享会话',
  'clouddrive.admin.jobs.handler.refresh_storage_usage': '刷新容量快照',
  'clouddrive.admin.jobs.status.success': '成功',
} as const
