export const ZH_CN_EMAIL_BACKUP = {
    "settings.email_backup": "邮箱备份",
    "settings.email_backup_enabled": "包含邮箱",
    "settings.email_backup_enabled_hint": "邮箱会以独立归档文件写入每个备份目标，与笔记和附件分开保存。",
    "settings.email_backup_attachments": "包含附件文件",
    "settings.email_backup_attachments_hint": "默认关闭。附件元数据始终包含；附件内容会显著增大备份体积。",
    "settings.email_backup_path": "归档路径",
    "settings.email_backup_path_hint": "清单指向该文件。启用附件后，附件文件会放在单独目录中。",
    "settings.email_backup_path_value": "归档：{value0}",
    "settings.email_backup_attachments_path_value": "附件：{value0}",
    "settings.email_backup_last_run": "上次备份",
    "settings.email_backup_run": "立即备份",
    "settings.email_backup_restore_hint": "在“设置 → 数据 → 恢复备份文件夹”中恢复。已存在的邮箱、文件夹、邮件与附件会跳过；未包含的附件文件会标记为缺失，而不会虚报恢复成功。",
} as const;
