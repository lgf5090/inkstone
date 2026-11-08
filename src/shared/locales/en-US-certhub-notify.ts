export const EN_US_CERTHUB_NOTIFY = {
  issuedTitle: 'Certificate issued · {name}',
  issuedBody: 'CA: {ca}\nDomains: {domains}\nExpires: {expiry}',
  renewedTitle: 'Certificate renewed · {name}',
  renewedBody: 'CA: {ca}\nDomains: {domains}\nNew expiry: {expiry}',
  renewFailedTitle: 'Certificate renewal failed · {name}',
  renewFailedBody: 'CA: {ca}\nRetry from CertHub. The previous certificate is still valid.',
  failedTitle: 'Certificate request failed · {name}',
  failedBody: 'CA: {ca}\nOpen CertHub for the reason and retry.',
  expiringTitle: 'Certificate expiring · {name}',
  expiringBody: 'CA: {ca}\nExpires: {expiry}\nRenewal has been scheduled.',
  revokedTitle: 'Certificate revoked · {name}',
  revokedBody: 'CA: {ca}\nThe certificate was revoked at the CA and its private key was purged.',
}
