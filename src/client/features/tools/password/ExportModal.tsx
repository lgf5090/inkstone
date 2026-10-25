import { useState } from 'react'
import { Download, Lock, AlertCircle } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Input, Checkbox, Segmented, Select } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import { getKeyIv } from './crypto'
import { toCSV } from './utils/csv-parser'
import { passwordApi } from './api'
import type { PasswordGroup } from '@shared/tools/password/types'

export type ExportFormat = 'csv' | 'txt'

export interface ExportModalProps {
  open?: boolean
  onClose?: () => void
  group?: PasswordGroup | null
}

function getGroupAndDescendantIds(groupId: string, groups: PasswordGroup[]): Set<string> {
  const result = new Set<string>([groupId])
  let changed = true
  while (changed) {
    changed = false
    for (const g of groups) {
      if (g.parentId && result.has(g.parentId) && !result.has(g.id)) {
        result.add(g.id)
        changed = true
      }
    }
  }
  return result
}

export function ExportModal({ open, onClose, group }: ExportModalProps) {
  const toast = useUi((s) => s.toast)
  const storeIsOpen = usePasswordVaultStore((s) => s.isExportModalOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeExportModal)
  const storeTargetGroup = usePasswordVaultStore((s) => s.targetGroupForExportImport)
  const groups = usePasswordVaultStore((s) => s.groups)
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const decryptedAccounts = usePasswordVaultStore((s) => s.decryptedAccounts)
  const keyIV = usePasswordVaultStore((s) => s.keyIV)
  const masterPasswordText = usePasswordVaultStore((s) => s.masterPasswordText)

  const isVisible = open !== undefined ? open : storeIsOpen
  const handleClose = onClose || storeClose
  const activeGroup = group !== undefined ? group : storeTargetGroup

  const [passwordInput, setPasswordInput] = useState<string>('')
  const [includeSubgroups, setIncludeSubgroups] = useState<boolean>(true)
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [saveToR2, setSaveToR2] = useState<boolean>(true)
  const [selectedGroupId, setSelectedGroupId] = useState<string>(activeGroup?.id || 'all')

  const [isExporting, setIsExporting] = useState<boolean>(false)
  const [errorMsg, setErrorMsg] = useState<string>('')

  // Verify master password
  const verifyIdentity = (): boolean => {
    if (!passwordInput) {
      setErrorMsg(t('tools.password.export.input_password'))
      return false
    }

    if (masterPasswordText && passwordInput === masterPasswordText) {
      return true
    }

    if (keyIV) {
      const derived = getKeyIv(passwordInput)
      if (derived.key === keyIV.key && derived.iv === keyIV.iv) {
        return true
      }
    }

    setErrorMsg(t('tools.password.door.fail'))
    return false
  }

  const handleExport = async () => {
    setErrorMsg('')
    if (!verifyIdentity()) {
      return
    }

    setIsExporting(true)
    try {
      // 1. Determine accounts to export
      let targetIds: Set<string> | null = null
      if (selectedGroupId !== 'all') {
        if (includeSubgroups) {
          targetIds = getGroupAndDescendantIds(selectedGroupId, groups)
        } else {
          targetIds = new Set([selectedGroupId])
        }
      }

      const rawAccounts = accounts.filter((a) => !targetIds || targetIds.has(a.groupId))
      if (rawAccounts.length === 0) {
        setErrorMsg(t('tools.password.export.no_accounts'))
        setIsExporting(false)
        return
      }
      const resolvedAccounts = rawAccounts.map((a) => {
        const dec = decryptedAccounts[a.id]
        return {
          title: dec?.title ?? a.title ?? '',
          username: dec?.username ?? a.username ?? '',
          password: dec?.password ?? a.password ?? '',
          link: dec?.link ?? a.link ?? '',
          remark: dec?.remark ?? a.remark ?? '',
        }
      })

      // 2. Format content
      let content = ''
      if (format === 'csv') {
        content = toCSV(resolvedAccounts)
      } else {
        content = resolvedAccounts
          .map(
            (a) =>
              `${t('tools.password.account.title')}: ${a.title}\n${t('tools.password.account.username')}: ${a.username}\n${t('tools.password.account.password')}: ${a.password}\n${t('tools.password.account.link')}: ${a.link}\n${t('tools.password.account.remark')}: ${a.remark}`
          )
          .join('\n\n--------------------------------------------------\n\n')
      }

      // 3. Trigger browser download
      const mime = format === 'csv' ? 'text/csv;charset=utf-8;' : 'text/plain;charset=utf-8;'
      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const filename = `inkstone_password_export_${Date.now()}.${format}`

      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      // 4. Save to R2 if enabled
      if (saveToR2) {
        try {
          await passwordApi.exportPlaintext(format, content)
        } catch {
          // Cloud save is non-blocking to browser download
        }
      }

      toast({
        title: t('tools.password.export.success'),
        tone: 'success',
      })
      setPasswordInput('')
      handleClose()
    } catch (err: any) {
      setErrorMsg(err?.message || t('tools.password.export.failed'))
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Modal
      open={isVisible}
      onClose={handleClose}
      title={t('tools.password.export.title')}
      width={520}
      dismissible={!isExporting}
    >
      <div className="flex flex-col gap-4 text-[var(--text-primary)]">
        {/* Verification section */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="export-master-password"
            className="flex items-center gap-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]"
          >
            <Lock size={13} />
            <span>{t('tools.password.export.verify_pass')}</span>
          </label>
          <Input
            id="export-master-password"
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            placeholder={t('tools.password.door.placeholder')}
            className="h-9 text-[length:var(--text-13)]"
            autoFocus
          />
        </div>

        {errorMsg && (
          <div className="flex items-center gap-2 rounded-[var(--r-md)] bg-red-500/10 p-2.5 text-[length:var(--text-12)] text-red-500">
            <AlertCircle size={15} />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Group scope */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.password.export.scope')}
          </span>
          <Select
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            className="h-8 text-[length:var(--text-12)]"
          >
            <option value="all">{t('tools.password.export.all_accounts')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {t('tools.password.export.group_prefix', { name: g.name })}
              </option>
            ))}
          </Select>
        </div>

        {/* Subgroups option */}
        {selectedGroupId !== 'all' && (
          <label className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-secondary)] cursor-pointer">
            <Checkbox checked={includeSubgroups} onChange={setIncludeSubgroups} />
            <span>{t('tools.password.export.include_subgroups')}</span>
          </label>
        )}

        {/* Format Selection */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.password.export.format')}
          </span>
          <Segmented<ExportFormat>
            value={format}
            onChange={setFormat}
            options={[
              { value: 'csv', label: t('tools.password.export.format_csv') },
              { value: 'txt', label: t('tools.password.export.format_txt') },
            ]}
          />
        </div>

        {/* Save to R2 option */}
        <label className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-secondary)] cursor-pointer">
          <Checkbox checked={saveToR2} onChange={setSaveToR2} />
          <span>{t('tools.password.export.r2_copy_label')}</span>
        </label>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClose}
            disabled={isExporting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleExport}
            loading={isExporting}
            icon={<Download size={14} />}
          >
            {t('tools.password.export.download')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
