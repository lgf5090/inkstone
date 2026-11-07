/**
 * The local half of command risk: patterns that are dangerous whatever the model would say.
 *
 * This runs on every keystroke without a network call, so the reader learns about `rm -rf /` or a
 * `dd` aimed at a disk before pressing Enter. The AI assessment is the second opinion, not the
 * first: a feature that needed a model call to notice `mkfs` would be useless on a bad connection.
 *
 * The rules are deliberately narrow. A false positive that stops a harmless command is worse than
 * a missed warning the AI panel can still give.
 */

import type { MessageKey } from '@shared/locales/en-US'

export type CommandRiskLevel = 'safe' | 'caution' | 'danger'

export interface CommandRiskMatch {
  ruleId: string
  level: 'caution' | 'danger'
  messageKey: MessageKey
}

export interface CommandRiskResult {
  level: CommandRiskLevel
  matches: CommandRiskMatch[]
}

interface CommandRiskRule extends CommandRiskMatch {
  pattern: RegExp
}

/**
 * Ordered most-specific first. A single line can match several rules; the caller shows every reason
 * and the dialog uses the highest level.
 */
export const COMMAND_RISK_RULES: readonly CommandRiskRule[] = [
  {
    ruleId: 'rm-root',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_rm_root',
    pattern: /\brm\b[^\n]*--no-preserve-root|\brm\b[^\n]*\s(?:\/(?:\s|$|\*)|~(?:\s|$|\/)|"\$HOME"|\$HOME|\$\{HOME\})(?:\s|$)/,
  },
  {
    ruleId: 'mkfs',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_mkfs',
    pattern: /\bmkfs(?:\.\w+)?\b/,
  },
  {
    ruleId: 'dd-device',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_dd_device',
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|vd|mmcblk|xvd|disk)/,
  },
  {
    ruleId: 'redirect-device',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_redirect_device',
    pattern: />\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk|xvd|disk)/,
  },
  {
    ruleId: 'chmod-root',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_chmod_root',
    pattern: /\bchmod\b[^\n]*\s(?:-R|--recursive)\b[^\n]*\s\/\s*$/,
  },
  {
    ruleId: 'chown-root',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_chown_root',
    pattern: /\bchown\b[^\n]*\s(?:-R|--recursive)\b[^\n]*\s\/\s*$/,
  },
  {
    ruleId: 'shutdown',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_shutdown',
    pattern: /\b(?:shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b/,
  },
  {
    ruleId: 'fork-bomb',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_fork_bomb',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  {
    ruleId: 'kill-all',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_kill_all',
    pattern: /\bkill\b[^\n]*\s-9\s+-1\b|\bkillall5\b/,
  },
  {
    ruleId: 'remote-shell',
    level: 'danger',
    messageKey: 'webssh.ai.risk.rule_remote_shell',
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
  },
  {
    ruleId: 'firewall-flush',
    level: 'caution',
    messageKey: 'webssh.ai.risk.rule_firewall_flush',
    pattern: /\b(?:iptables|nft)\b[^\n]*\s(?:-F|--flush)\b|\bufw\s+disable\b/,
  },
  {
    ruleId: 'service-stop',
    level: 'caution',
    messageKey: 'webssh.ai.risk.rule_service_stop',
    pattern: /\bsystemctl\s+(?:stop|disable|mask)\s+\S+|\bservice\s+\S+\s+stop\b/,
  },
  {
    ruleId: 'package-remove',
    level: 'caution',
    messageKey: 'webssh.ai.risk.rule_package_remove',
    pattern: /\b(?:apt(?:-get)?|yum|dnf)\s+(?:remove|purge)\b|\bpacman\s+-R\b/,
  },
  {
    ruleId: 'truncate',
    level: 'caution',
    messageKey: 'webssh.ai.risk.rule_truncate',
    pattern: /\btruncate\b[^\n]*\s-s\s*0\b|>\s*\/etc\//,
  },
  {
    ruleId: 'docker-prune',
    level: 'caution',
    messageKey: 'webssh.ai.risk.rule_docker_prune',
    pattern: /\bdocker\s+(?:system|volume|image|container)\s+prune\b/,
  },
  {
    ruleId: 'git-reset',
    level: 'caution',
    messageKey: 'webssh.ai.risk.rule_git_reset',
    pattern: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/,
  },
  {
    ruleId: 'recursive-delete',
    level: 'caution',
    messageKey: 'webssh.ai.risk.rule_recursive_delete',
    pattern: /\brm\b[^\n]*\s(?:-r|-R|-rf|-fr|-Rf|-fR)\b/,
  },
  {
    ruleId: 'world-writable',
    level: 'caution',
    messageKey: 'webssh.ai.risk.rule_world_writable',
    pattern: /\bchmod\b[^\n]*\b777\b/,
  },
]

function normalize(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * The risk of one command line. `safe` is only "no rule matched", never "the model approved it".
 */
export function detectCommandRisk(command: string): CommandRiskResult {
  const text = normalize(command)
  if (!text) return { level: 'safe', matches: [] }
  const matches: CommandRiskMatch[] = []
  for (const rule of COMMAND_RISK_RULES) {
    if (!rule.pattern.test(text)) continue
    // A shared global/sticky flag would move the match position between calls; these are none.
    matches.push({ ruleId: rule.ruleId, level: rule.level, messageKey: rule.messageKey })
  }
  const level: CommandRiskLevel = matches.some((match) => match.level === 'danger')
    ? 'danger'
    : matches.length
      ? 'caution'
      : 'safe'
  return { level, matches }
}

/** The line the reader appears to be typing, stripped of a prompt prefix when one is visible. */
export function commandFromPromptLine(line: string): string {
  const text = line.replace(/\s+$/, '')
  const marker = text.lastIndexOf('$ ')
  const hash = text.lastIndexOf('# ')
  const chevron = text.lastIndexOf('> ')
  const at = Math.max(marker, hash, chevron)
  return at >= 0 ? text.slice(at + 2).trim() : text.trim()
}
