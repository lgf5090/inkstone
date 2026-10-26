import { Empty } from '../../../components/feedback'
import { cfT } from '../i18n'
import type { CloudflareAiTab } from '../cloudflare-address'

export function AiScreen({ tab }: { tab: CloudflareAiTab }) {
  void tab
  return <Empty title={cfT('cloudflare.ai.title')} />
}
