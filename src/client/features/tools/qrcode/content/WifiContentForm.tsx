import { useState } from 'react'
import { Eye, EyeOff, Lock, Wifi } from 'lucide-react'
import { useQrCodeStore } from '../store'
import { Checkbox, Field, Input, Segmented } from '../../../../components/form'
import { IconButton } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'

export function WifiContentForm() {
  const [showPassword, setShowPassword] = useState(false)
  const wifiContent = useQrCodeStore((s) => s.wifiContent)
  const setWifiContent = useQrCodeStore((s) => s.setWifiContent)

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('tools.qrcode.content.wifi_ssid')}>
        <Input
          value={wifiContent.ssid}
          onChange={(e) => setWifiContent({ ssid: e.target.value })}
          placeholder="My-Home-WiFi"
          leading={<Wifi size={15} className="text-[var(--text-tertiary)]" />}
        />
      </Field>

      <Field label={t('tools.qrcode.content.wifi_encryption')}>
        <Segmented<'WPA' | 'WEP' | 'none'>
          value={wifiContent.encryption}
          onChange={(enc) => setWifiContent({ encryption: enc })}
          options={[
            { value: 'WPA', label: 'WPA/WPA2' },
            { value: 'WEP', label: 'WEP' },
            { value: 'none', label: t('tools.qrcode.content.wifi_no_password') },
          ]}
        />
      </Field>

      {wifiContent.encryption !== 'none' && (
        <Field label={t('tools.qrcode.content.wifi_password')}>
          <Input
            type={showPassword ? 'text' : 'password'}
            value={wifiContent.password || ''}
            onChange={(e) => setWifiContent({ password: e.target.value })}
            placeholder={t('tools.qrcode.content.wifi_password_placeholder')}
            leading={<Lock size={15} className="text-[var(--text-tertiary)]" />}
            trailing={
              <IconButton
                size="sm"
                label={showPassword ? t('tools.qrcode.content.hide_password') : t('tools.qrcode.content.show_password')}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </IconButton>
            }
          />
        </Field>
      )}

      <Checkbox
        checked={Boolean(wifiContent.hidden)}
        onChange={(checked) => setWifiContent({ hidden: checked })}
        label={t('tools.qrcode.content.wifi_hidden')}
      />
    </div>
  )
}
