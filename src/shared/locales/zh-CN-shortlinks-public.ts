/**
 * The Chinese counterpart of the public `/l/:slug` page copy.
 */
import type { ShortlinksPublicCopy } from './en-US-shortlinks-public'

export const ZH_CN_SHORTLINKS_PUBLIC: ShortlinksPublicCopy = {
  passwordTitle: '受保护的链接',
  passwordHeading: '受保护的短链接',
  passwordMessage: '此短链接已设置访问密码保护，请输入正确的访问密码以继续跳转。',
  passwordLabel: '访问密码',
  passwordPlaceholder: '请输入访问密码',
  passwordSubmit: '验证并跳转',
  tooManyAttempts: '密码错误次数过多，请在 {minutes} 分钟后重试。',
  wrongPassword: '访问密码错误，请重新输入。',
  notFoundTitle: '短链接不存在',
  notFoundMessage: '抱歉，您访问的短链接不存在或已被删除。',
  disabledTitle: '链接已停用',
  disabledMessage: '该短链接已被创建者暂时停用。',
  expiredTitle: '链接已过期',
  expiredMessage: '该短链接已达到预设有效期限并已过期失效。',
  invalidTargetTitle: '链接不可用',
  invalidTargetMessage: '该短链接没有指向可打开的网页地址。',
  unsafeTitle: '该链接可能存在风险',
  unsafeMessage: '创建者已标记此目标地址可能存在意外或不安全内容。请只在信任分享者时继续访问。',
  unsafeConfirm: '继续访问目标地址',
  unsafeCancel: '返回 Inkstone',
}
