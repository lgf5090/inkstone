export const ZH_CN_CERTHUB_NOTIFY = {
  issuedTitle: '证书已签发 · {name}',
  issuedBody: 'CA：{ca}\n域名：{domains}\n到期：{expiry}',
  renewedTitle: '证书已续期 · {name}',
  renewedBody: 'CA：{ca}\n域名：{domains}\n新到期：{expiry}',
  renewFailedTitle: '证书续期失败 · {name}',
  renewFailedBody: 'CA：{ca}\n可在 CertHub 重试；旧证书仍然有效。',
  failedTitle: '证书申请失败 · {name}',
  failedBody: 'CA：{ca}\n可在 CertHub 查看原因并重试。',
  expiringTitle: '证书即将到期 · {name}',
  expiringBody: 'CA：{ca}\n到期：{expiry}\n已按计划发起续期。',
  revokedTitle: '证书已吊销 · {name}',
  revokedBody: 'CA：{ca}\n该证书已从 CA 吊销，私钥已清除。',
}
