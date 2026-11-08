import { useState } from 'react'
import { ChevronLeft, ChevronRight, CircleHelp, ExternalLink } from 'lucide-react'
import { Drawer } from '../../../components/overlay'
import { Button, SectionLabel } from '../../../components/primitives'
import { CopyButton } from '../../../components/copy-button'
import { navigateToPath } from '../../../lib/app-history'
import { t } from '../../../lib/i18n'

export const HELP_TOPIC_ORDER = ['overview', 'certificates', 'apply', 'accounts', 'dns', 'settings', 'api', 'admin'] as const
export type HelpTopicId = (typeof HELP_TOPIC_ORDER)[number]

export interface HelpSection {
  title: string
  body?: string
  steps?: string[]
  links?: Array<{ label: string; href: string }>
  commands?: Array<{ label: string; command: string }>
}

export interface HelpTopic {
  intro: string
  sections: HelpSection[]
  related: Array<{ label: string; path: string }>
}

function helpText(topic: HelpTopicId, name = 'intro'): string {
  return t(`development.certhub.help.${topic}.${name}` as never)
}

function subText(topic: HelpTopicId, name: string): string {
  return t(`development.certhub.help.${topic}.${name}` as never)
}

function stepText(topic: HelpTopicId, group: string, name: string): string {
  return t(`development.certhub.help.${topic}.${group}.${name}` as never)
}

function officialLink(name: string, href: string): { label: string; href: string } {
  return { label: t(`development.certhub.help.link.${name}` as never), href }
}

const OFFICIAL = {
  leStart: ['le_start', 'https://letsencrypt.org/getting-started/'],
  leStaging: ['le_staging', 'https://letsencrypt.org/docs/staging-environment/'],
  leLimits: ['le_limits', 'https://letsencrypt.org/docs/rate-limits/'],
  leChallenge: ['le_challenge', 'https://letsencrypt.org/docs/challenge-types/'],
  zerossl: ['zerossl', 'https://zerossl.com/documentation/acme/'],
  gts: ['gts', 'https://pki.goog/faq/'],
  sslcom: ['sslcom', 'https://www.ssl.com/products/website-security/acme/'],
} as const

function navLabel(id: HelpTopicId): string {
  return t(`development.certhub.nav.${id}` as never)
}

export function buildTopic(id: HelpTopicId): HelpTopic {
  const related = (...ids: HelpTopicId[]) => ids.map((next) => ({
    label: navLabel(next),
    path: next === 'overview' ? '/development/certhub' : `/development/certhub/${next}`,
  }))
  switch (id) {
    case 'overview':
      return {
        intro: helpText(id),
        sections: [
          { title: subText(id, 'cards_title'), body: subText(id, 'cards_body') },
          { title: subText(id, 'quota_title'), body: subText(id, 'quota_body') },
          { title: subText(id, 'events_title'), body: subText(id, 'events_body') },
        ],
        related: related('certificates', 'apply'),
      }
    case 'certificates':
      return {
        intro: helpText(id),
        sections: [
          { title: subText(id, 'list_title'), body: subText(id, 'list_body') },
          { title: subText(id, 'status_title'), body: subText(id, 'status_body') },
          { title: subText(id, 'download_title'), body: subText(id, 'download_body') },
        ],
        related: related('apply', 'settings'),
      }
    case 'apply':
      return {
        intro: helpText(id),
        sections: [
          {
            title: subText(id, 'flow_title'),
            body: subText(id, 'flow_body'),
            steps: ['step_1', 'step_2', 'step_3', 'step_4', 'step_5', 'step_6', 'step_7'].map((name) => stepText(id, 'flow', name)),
          },
          {
            title: subText(id, 'ca_title'),
            body: subText(id, 'ca_body'),
            links: [OFFICIAL.leStart, OFFICIAL.leStaging, OFFICIAL.leLimits, OFFICIAL.zerossl, OFFICIAL.gts, OFFICIAL.sslcom]
              .map(([name, href]) => officialLink(name, href)),
          },
          { title: subText(id, 'challenge_title'), body: subText(id, 'challenge_body') },
          {
            title: subText(id, 'txt_title'),
            body: subText(id, 'txt_body'),
            steps: ['txt_1', 'txt_2', 'txt_3', 'txt_4', 'txt_5'].map((name) => stepText(id, 'txt', name)),
          },
          {
            title: subText(id, 'verify_title'),
            body: subText(id, 'verify_body'),
            commands: [
              { label: subText(id, 'cmd_dig'), command: 'dig +short TXT _acme-challenge.example.com' },
              { label: subText(id, 'cmd_nslookup'), command: 'nslookup -type=TXT _acme-challenge.example.com 1.1.1.1' },
            ],
            links: [officialLink(OFFICIAL.leChallenge[0], OFFICIAL.leChallenge[1])],
          },
          {
            title: subText(id, 'fail_title'),
            steps: ['unauthorized', 'nxdomain', 'invalid', 'too_many', 'rate_limited', 'rejected_identifier'].map((name) => stepText(id, 'fail', name)),
          },
          {
            title: subText(id, 'limits_title'),
            steps: ['free', 'domain', 'orders', 'identical', 'failures', 'changing'].map((name) => stepText(id, 'limits', name)),
          },
        ],
        related: related('accounts', 'dns'),
      }
    case 'accounts':
      return {
        intro: helpText(id),
        sections: [
          { title: subText(id, 'create_title'), body: subText(id, 'create_body') },
          { title: subText(id, 'rotate_title'), body: subText(id, 'rotate_body') },
        ],
        related: related('apply'),
      }
    case 'dns':
      return {
        intro: helpText(id),
        sections: [
          { title: subText(id, 'cloudflare_title'), body: subText(id, 'cloudflare_body') },
          { title: subText(id, 'delegate_title'), body: subText(id, 'delegate_body') },
          { title: subText(id, 'manual_title'), body: subText(id, 'manual_body') },
        ],
        related: related('apply'),
      }
    case 'settings':
      return {
        intro: helpText(id),
        sections: [
          { title: subText(id, 'defaults_title'), body: subText(id, 'defaults_body') },
          { title: subText(id, 'notify_title'), body: subText(id, 'notify_body') },
          { title: subText(id, 'tokens_title'), body: subText(id, 'tokens_body') },
        ],
        related: related('api', 'admin'),
      }
    case 'api':
      return {
        intro: helpText(id),
        sections: [
          { title: subText(id, 'auth_title'), body: subText(id, 'auth_body') },
          { title: subText(id, 'scopes_title'), body: subText(id, 'scopes_body') },
          { title: subText(id, 'endpoints_title'), body: subText(id, 'endpoints_body') },
        ],
        related: related('settings'),
      }
    case 'admin':
      return {
        intro: helpText(id),
        sections: [
          { title: subText(id, 'limits_title'), body: subText(id, 'limits_body') },
          { title: subText(id, 'queue_title'), body: subText(id, 'queue_body') },
        ],
        related: related('settings'),
      }
  }
}

export function HelpButton({ topic }: { topic: HelpTopicId }) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<HelpTopicId>(topic)
  const index = HELP_TOPIC_ORDER.indexOf(current)
  const show = (next: HelpTopicId) => setCurrent(next)
  const content = buildTopic(current)
  return (
    <>
      <Button size="sm" variant="ghost" aria-label={t('development.certhub.help.open')} onClick={() => { setCurrent(topic); setOpen(true) }} icon={<CircleHelp size={15} />} />
      <Drawer open={open} onClose={() => setOpen(false)} title={t('development.certhub.help.title')} width={460} bodyClassName="p-4">
        <div className="space-y-4 pb-4">
          <p className="text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-secondary)]">{content.intro}</p>
          {content.sections.map((section) => (
            <section key={section.title}>
              <SectionLabel>{section.title}</SectionLabel>
              {section.body ? <p className="mt-1 whitespace-pre-line text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{section.body}</p> : null}
              {section.steps ? (
                <ol className="mt-1.5 list-decimal space-y-1.5 pl-5 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
                  {section.steps.map((step, stepIndex) => <li key={`${section.title}-${stepIndex}`}>{step}</li>)}
                </ol>
              ) : null}
              {section.links ? (
                <div className="mt-1.5 flex flex-col gap-1">
                  {section.links.map((link) => (
                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[length:var(--text-12)] text-[var(--accent)] hover:underline">
                      {link.label}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  ))}
                </div>
              ) : null}
              {section.commands ? (
                <div className="mt-1.5 space-y-1.5">
                  {section.commands.map((entry) => (
                    <div key={entry.command} className="flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-2 py-1.5">
                      <code className="min-w-0 flex-1 break-all text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{entry.command}</code>
                      <CopyButton text={entry.command} label={entry.label} />
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
          <section>
            <SectionLabel>{t('development.certhub.help.related')}</SectionLabel>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {content.related.map((page) => (
                <Button key={page.path} size="sm" onClick={() => { setOpen(false); navigateToPath(page.path) }}>{page.label}</Button>
              ))}
            </div>
          </section>
        </div>
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-2 flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-2">
          <Button size="sm" variant="ghost" icon={<ChevronLeft size={14} />} disabled={index <= 0} onClick={() => show(HELP_TOPIC_ORDER[index - 1]!)}>{t('development.certhub.help.prev')}</Button>
          <Button size="sm" variant="ghost" trailing={<ChevronRight size={14} />} disabled={index >= HELP_TOPIC_ORDER.length - 1} onClick={() => show(HELP_TOPIC_ORDER[index + 1]!)}>{t('development.certhub.help.next')}</Button>
        </div>
      </Drawer>
    </>
  )
}
