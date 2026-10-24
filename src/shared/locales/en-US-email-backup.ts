export const EN_US_EMAIL_BACKUP = {
    "settings.email_backup": "Email backup",
    "settings.email_backup_enabled": "Include email",
    "settings.email_backup_enabled_hint": "Mailboxes are written into every backup target as their own archive file, separate from notes and attachments.",
    "settings.email_backup_attachments": "Include attachment files",
    "settings.email_backup_attachments_hint": "Off by default. Attachment metadata is always included; attachment bytes can make a backup much larger.",
    "settings.email_backup_path": "Archive path",
    "settings.email_backup_path_hint": "The manifest points at this file. Attachment files live under their own directory only when enabled.",
    "settings.email_backup_path_value": "Archive: {value0}",
    "settings.email_backup_attachments_path_value": "Attachments: {value0}",
    "settings.email_backup_last_run": "Last backup",
    "settings.email_backup_run": "Back up now",
    "settings.email_backup_restore_hint": "Restore from Settings → Data → Restore backup folder. Existing mailboxes, folders, messages and attachments are skipped, and attachment files that were not included are reported as missing rather than restored.",
} as const;
