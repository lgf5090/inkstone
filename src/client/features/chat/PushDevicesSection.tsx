/**
 * The push rows: whether this device may be woken up, and which devices this account has woken.
 *
 * It hangs in the data group of assistant settings (`DataTab`), beside the export and the file list, because
 * the reader who comes here is asking what leaves their account — and a push is the one thing that leaves it
 * on its own: the worker sends an empty shell, the notice carries no note text, and what is waiting is only
 * readable by opening the app signed in.
 *
 * The rule the whole screen is written against is that a control never lies. A switch appears when the
 * deployment can push, when this browser can be subscribed, and when the reader has not already been told no
 * by their own browser; in every other case the row says which of those is missing. Nothing on the screen
 * sends a reader to a control the screen did not draw — which is why the device list sits under the
 * deployment that can push rather than beside a notice saying it cannot — and the server's own line
 * (`reason`, naming the variable that was never set) is reached from a disclosure under the localized
 * sentence rather than printed as the sentence itself.
 */
import { useEffect } from 'react'
import { BellRing, Trash2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Button, Spinner } from '../../components/primitives'
import { SettingRow, Switch } from '../../components/form'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { Group, LoadFailure } from './assistant-settings-shared'
import { rowForId, usePushDevices } from './push-devices'
import { formatInZone } from './time-format'

export function PushDevicesSection() {
  const { config, configFailure, rows, rowsFailure, deviceEndpoint, deviceId, support, permission, busy, revoking, revokeFailure, actionFailure, loadConfig, loadRows, readDevice, enable, disable, revoke } = usePushDevices()
  const timezone = useAssistant((state) => state.settings?.timezone)
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    void loadConfig()
    void loadRows()
    void readDevice()
  }, [loadConfig, loadRows, readDevice])

  const serverReady = config?.enabled === true
  const browserReady = support === 'available' && (permission === 'granted' || permission === 'default')
  // Whether the switch the list's empty sentence sends a reader to is on the screen at all. The row above it
  // draws that switch under one condition and a re-check button under its opposite, so the sentence that
  // names it is gated on the same condition instead of on a guess about it.
  const switchShown = serverReady && browserReady
  // The reader's own row, by the id the account gave it when this device subscribed. Nothing here looks at
  // endpoint text: the list carries a digest of each endpoint and the browser holds the credential, so an id
  // is the only thing both sides are allowed to compare.
  const thisRow = rowForId(deviceId, rows ?? [])

  /**
   * The press, and the two things it can turn into.
   *
   * A refusal stays on the row as an inline block rather than a toast that leaves: the reader is looking at
   * the switch that did not move, and the reason has to be where their attention already is.
   */
  const press = async (next: boolean): Promise<void> => {
    if (next) {
      await enable()
      const after = usePushDevices.getState()
      if (!after.actionFailure && after.deviceEndpoint) toast({ title: t('assistant.push.enabled'), tone: 'success' })
      return
    }
    await disable()
    const after = usePushDevices.getState()
    if (!after.actionFailure) toast({ title: t('assistant.push.disabled'), tone: 'success' })
  }

  /**
   * Removes one row of the list, whichever device it names.
   *
   * The same rule as the press: a refusal is printed where the button that caused it is, with the route's own
   * line under it and a retry that asks for the same row again.
   */
  const revokeRow = async (id: string): Promise<void> => {
    await revoke(id)
    const after = usePushDevices.getState()
    if (after.revokeFailure?.id !== id) toast({ title: t('assistant.push.revoke_done'), tone: 'success' })
  }

  const description = (): string => {
    if (config === null && !configFailure) return t('assistant.push.reading')
    if (!serverReady) return t('assistant.push.server_off')
    if (support === 'insecure') return t('assistant.push.insecure')
    if (support === 'unsupported') return t('assistant.push.unsupported')
    if (permission === 'denied') return t('assistant.push.denied')
    if (permission === 'unavailable') return t('assistant.push.unsupported')
    return deviceEndpoint ? t('assistant.push.enabled') : t('assistant.push.hint')
  }

  return (
    <Group title={t('assistant.push.title')}>
      <div className="flex flex-col gap-1.5 py-2.5">
        <p className="text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">
          {t('assistant.push.transport_hint')}
        </p>

        {configFailure && (
          <LoadFailure messageKey="assistant.push.load_failed" detail={configFailure.detail} onRetry={() => void loadConfig()} />
        )}

        {serverReady === false && config !== null && (
          <div role="status" className="flex flex-col gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2.5">
            <p className="text-[length:var(--text-12)] text-[var(--text-primary)]">{t('assistant.push.server_off')}</p>
            <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
              {t('assistant.push.server_off_hint')}
            </p>
            {/* Collapsed on purpose: the route's line is the deployment's own words, which name the variables
                an operator has to set and are not the sentence this screen says. It stays reachable, because
                it is the one part of this a reader could not guess. */}
            {config.reason && (
              <details className="flex flex-col gap-1">
                <summary className="cursor-pointer text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {t('assistant.push.server_off_detail')}
                </summary>
                <p className="break-words text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-tertiary)]">
                  {config.reason}
                </p>
              </details>
            )}
          </div>
        )}

        {serverReady && (
          <SettingRow title={t('assistant.push.row')} description={description()}>
            {browserReady ? (
              <Switch
                checked={deviceEndpoint !== null}
                disabled={busy !== null}
                label={t('assistant.push.switch_label')}
                onChange={(next) => { void press(next) }}
              />
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon={<BellRing size={13} />}
                onClick={() => { void readDevice().then(() => loadConfig()) }}
              >
                {t('assistant.push.recheck')}
              </Button>
            )}
          </SettingRow>
        )}

        {busy !== null && (
          <p role="status" className="flex items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <Spinner />
            {t('assistant.push.running')}
          </p>
        )}

        {actionFailure && (
          <LoadFailure
            messageKey={actionFailure.headline}
            detail={actionFailure.detail}
            onRetry={() => { void press(deviceEndpoint === null) }}
          />
        )}
      </div>

      {/* The devices that receive pushes belong to the deployment that can send them. Where the keys were
          never set there is no switch above this block and nothing could have subscribed, so drawing it
          would hang a heading and a sentence over controls the screen deliberately does not offer. */}
      {serverReady && (
        <div className="flex flex-col gap-1.5 pb-2.5">
          <p className="text-[length:var(--text-11-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
            {t('assistant.push.devices')}
          </p>

          {rows === null && !rowsFailure && (
            <p role="status" className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
              {t('assistant.push.devices_reading')}
            </p>
          )}

          {rowsFailure && (
            <LoadFailure messageKey="assistant.push.devices_failed" detail={rowsFailure.detail} onRetry={() => void loadRows()} />
          )}

          {/* Two empty lists that are two different facts: the switch above is the way out of one, and is not
              on the screen for the other, where the row carries the re-check instead. */}
          {rows !== null && rows.length === 0 && (
            <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
              {t(switchShown ? 'assistant.push.devices_empty' : 'assistant.push.devices_none')}
            </p>
          )}

          {rows !== null && rows.length > 0 && (
            <ul aria-label={t('assistant.push.devices')} className="flex flex-col gap-1">
              {rows.map((row) => {
                const mine = thisRow?.id === row.id
                return (
                  <li
                    key={row.id}
                    className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-secondary)]" title={row.endpoint}>
                        {row.endpoint}
                      </p>
                      <p className="truncate text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
                        {formatInZone(row.createdAt, timezone)}
                        {row.failures > 0 && <> · {t('assistant.push.failures', { count: row.failures })}</>}
                        {row.lastError && <> · {t('assistant.push.last_error')} · {row.lastError}</>}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!mine && (
                        <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                          {t('assistant.push.not_this_device')}
                        </span>
                      )}
                      {/* Every row is revocable, because every row carries the one handle its delete needs —
                          its own id. This device's row goes through the switch's own path so the browser is
                          unsubscribed with it; the others are removed here and take effect on that machine the
                          next time its reader comes back to this screen. */}
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Trash2 size={12} />}
                        loading={mine ? busy === 'disable' : revoking === row.id}
                        disabled={busy !== null || revoking !== null}
                        onClick={() => {
                          if (mine) void press(false)
                          else void revokeRow(row.id)
                        }}
                      >
                        {t(mine ? 'assistant.push.revoke' : 'assistant.push.revoke_other')}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {revokeFailure && (
            <LoadFailure
              messageKey="assistant.push.revoke_failed"
              detail={revokeFailure.detail}
              onRetry={() => { void revokeRow(revokeFailure.id) }}
            />
          )}

          {rows !== null && rows.length > 0 && (
            <p className="text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">
              {t('assistant.push.revoke_hint')}
            </p>
          )}
        </div>
      )}
    </Group>
  )
}
