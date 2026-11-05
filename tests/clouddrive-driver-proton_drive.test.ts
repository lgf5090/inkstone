// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProtonDriveDriver } from '../src/worker/clouddrive/drivers/proton_drive'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

/**
 * Fixtures come from a real GnuPG keychain (RSA user/address/share/file keys plus a cv25519
 * `curve25519Legacy` node key), so list/stat/read exercise the actual OpenPGP decryption rather
 * than a round-trip against this driver's own encoder.
 */
const FIXTURES: Record<string, string> = {
  userSec: 'LS0tLS1CRUdJTiBQR1AgUFJJVkFURSBLRVkgQkxPQ0stLS0tLQoKbFFQR0JHcnNiZjhCQ0FDa0VlZXhyZU1WenBNSjUzb2htZGNlU2J6K2lwaU9pVEVaKzVSWk5LZ0ZMK3RHU3F6dwpyVk9QbWg2RDZ1Z1BhUW5wbW5iUnd0RUlrcWtsTXpKZkdCK1c0d1lnMmlSczBDYVFydXhGQ3VBdkhOOUZxQXZmClFvNCtWNzZid0dnQTFxa1ZudXdJWDFaclZFZXpxT2dPYmtvd292cEx4RnR2QTVYZ1JseUxRWWFpd1BjaUUxdlMKdGE5M09sMkEranBDNFR2Zy9ZKzBVekYrM3RjVVlvVHBIQUtweStyaXMyQ3BCK01SZWlGL2lZY2tGcTlMZzY3cApCM0E5d0J5L2dmWHFrWFFiVzVSTEFLTVJwQTdHT0dzekszaW9VcFF0eFlySUE2YXJFK2ZyTXBqQ1Ira2J6V2psClo5Zk1sTEhYbmwyM3ZwcE1MdVVYWS96eUVHWldSOVI3eTZrTEFCRUJBQUgrQndNQ0dYaEc0VHBlM1NEL0JET04KeXYvMTNBbWdDcGdjZ1pQRUgvUHVVbkNucTBPMDNIZldkRWVvbEprWTFLUXQ0UCt5bjk5Yzd0a1ZETlVXOWMrSQo4T0xBbG5pdlB4NExzWE9WZHJqQmYzVUFxV0RIems4VWJaMmFxaDhseWhtbkVaalc1b1R5NldwTC8zWTBTaUF5ClpuY2JKQ1ZSWTQ5ZGkyVG9uUGNodHltVjlVcHZhUUYwc3NLM1lSRFZ0ZnNJV1Y4SGJxOFJhcGNhd0VhcElCSFMKdjVMYmRKUkhlL09sNEhLOFV4U1ZFWHB1NUoyYlZGTi9KNHlPWUUyeWtaT0xGbStUQmgrbXlDRC9ySW9SR1dsbwp0ODAzemV3d3BEdjU1YU43eVcrRkpteTdqUzBYeW5LLzVNZVlNeVZVdnhXYS8yOVRNc05ZMC9TeUw4RzVxeFRmCkt1UEFQL0REenU3elA1SEk4bHUzNThzY3NiZTJ0aUpFZm5MWmQxM2x1YWdibXJFWGhicDc4b2gvUmV2WE54UVMKTzdXVjlLTGE3N2Y4eVJqTElWQXkrbkR6TDgyay9sZHNlSWFPcFpUTFZuWXJGb2g0Szhac2RyZ2huNUdhbTlRWQp2QW9YN2E4b2swR2RoU3ZsSVFaQkg5TGpJM1Q2cy92bnJzRXV3NVJweFlhV0lmOHFtSS9lZEg4SUF6bW5pQTJICksxQWoxbmpvR2RhenhSWjZzSkVsN0gwVDFDTXNYckE3WE5DVVlMa0VEV3Jtbi9Cc09QcXRjOVlzb2lqWXlxN1kKV3QwNUFaNmJ3aFcwZ2JXZGxvQkk5QWJMRlBGU09saVpCN05OV0ZOYlpSc1NzdCtsZDQzc0RrQWo5UG1ieGUvNwp0cEFYNVBVM29lTHIzQ1RxRXFaWGpVdmlEOTlVZU0wUVZPM3pnWHBNbk5BVUZuMmZMbDEvKzdMT3ZWRjhzN0JCClhEWGJGb0Fxbko2VURDNi9ldlpPQ0pQRFR4YjdmN0swc1VjOVhCQmRkckZUQ0o1cFZoUUNEM3FzdStXWmpNdEcKL1F1MXMzY2JILzZYR050ck5GdU5FZFNiQlkyTE1veUltTWZLQVFpV2pUMzg5YnFSenRGb285ajJneHFUZ0wvSwo5bmd4eDIxTHpibWtjMjNJd0JHamgvMjhXNlROWXZSM21WL3NEbzgza0RhVUxhZU5SV2FHelFQdFdYVnNMYUc1Cm9idWpwMkt2eXkrbXRCNVFjbTkwYjI0Z1ZYTmxjaUE4ZFhObGNrQmxlR0Z0Y0d4bExtTnZiVDZKQVU0RUV3RUsKQURnV0lRUy8xb0lXbkhDMXh6eGw3aFhyb2tXdWU4dzk4UVVDYXV4dC93SWJEUVVMQ1FnSEFnWVZDZ2tJQ3dJRQpGZ0lEQVFJZUFRSVhnQUFLQ1JEcm9rV3VlOHc5OFdlMUIvMFZndU9jMkluREt0bkxLSTUrQ2ViTExFdmExQ0dlCkEyVXJqWERhZXg4TnM2MnFFY3ZyN3FMSnFJbWp1WGEvRW9RRWd0cmlWdFQ0dFY3VjU4MU5SZlhHRFk5NjNlQ3QKNnhZOUlsdkk2c05uVDFzN3Z1bVBWK1ZTM3hRaHNVYUxrMHVlTmFxWUQ1ZEV0L0Z3RHpOYmZudnV0VWxiMHVZOQpUQ0JWUWcwejVHL0p6WnduVUFRaEVFb09pT2NScjFSL0g4dDhYRFJkSGk3K1hKYitMelNiMHlXTEJSTURSRkRlCmU5U29wYmYxM1cvdVl0ak8zTDhwMkZ4d09sdUtETWFSeEF4K1ZLSXoxR0ZzN0c1S1RBY2dvczlnQmliYnNvSDYKNk8yckxNcFl5OXBaS1h1Um9WV3l3Z1dkVW9oK2ttQjdxWUhLTmZiSjNyNTUwclZqSFFjaFQvSEIKPU55dVUKLS0tLS1FTkQgUEdQIFBSSVZBVEUgS0VZIEJMT0NLLS0tLS0K',
  addrSec: 'LS0tLS1CRUdJTiBQR1AgUFJJVkFURSBLRVkgQkxPQ0stLS0tLQoKbFFQR0JHcnNiZ29CQ0FEbTc4NmNMOEszbDJXZU04VDVjaFp5U2lSalc0SUd0QWl1ZFJ0OGJZZGI4cmVNQUpuKwpEWlZlWE5FRTNzeGY2SVBjT3JKUjZpN3p6bElRemEveDhWTUs4UUFaZnNBRzlDaGVLalJURHVHQll0VWxQajVzCldLZHNFendjZmN4LytES3ZuRE1SK0RnT1VmZ0h4d3ZlZnhnVVpDZml2WUxpRllzU0oyWFc4WE1jSWQ0ODAvR2wKNm1EdTdDNnZWS3BTd0s0TWU4MHJBOCtyNVYrdVhXbklwZ3U2LzdncThDNk9mZmsvZFNqNXZoT2RmZCszWi9YZwpFaEhUWWY0SGtmUk03bnR5bmtLZ1MyRWZtUXBONTdSb0tKczg0OHF6Uy9Xd2k3L0tQZ3BkdmlmWHpkZklTa1ZlCjFhSUJhQUR3Y2JQOEU1bE41Qkh2ZjVSRkt3VUEweTFnQlVXbEFCRUJBQUgrQndNQ1gyZE9PNVVOZE5EL29GdWEKR1BqcGNxNFBEM2RRVmEwSEUwK3NuOVdabDdaWXdJWlZxZE45YnJsMW4rOVpDcVVXVHlBNVVuaWt0UG9oOXpoQgo3RVhndkZ3ZnhuenlpWDRLVVpjZHlhcXRYRXU5WUNIaWVuemJNYmVnTVdxODdkcnZNTUxpL3ZCNmcycVFQZlUzClVQaXBjNU4remx3UzlXWUtIemUyc1IvTzBjM1RsK1dEdjFuejUxSTdXV0QzL0hwWXk3Tld6cmVxZi8rY3JkOUMKOTBzWEFoRXdoYmo0QWtiWVlXN2U3dlg3QUhGa2xqZWtuRXZRNVhYNnh2RmZCWWtwWUhaclIvaGl3eUdtaHdBWgpDMklkM3J0TU4wM21LQ1FTY2ZxdHJreGxEMlFjRzFLaXJ6VG0vaTZWSmJaUWJtVlZ5S3FPRC9yUTh2YUp3YlBRCloxUkFtSnd1VzZ0RllLV05GUXRyb2FsQTA0bHVHU0pqZGxZL1ExQ1pWSlhjcVAxZkhCMExpZ3hqRDNGYzByQWEKaGV4eThPajNIRUtkRGhmdzR2dkVWaUpZSERRWlh6VktyM0w2bFQ1WXIxeFVUMjFUNmRNNEE0YTBJQ0JqcXZwaAp5djE4UjZHQWlUS1AxeEhwNmJkY09TTzBMVlIwWUdXMXEyVjM3Z000QkFKZlp2U1c0TzJrUlREeUwzY3hnUGE5CnR5TGNZYy92NlNDdm80bjBpd00yTmUvREdoVVFpWjNlOXVrZi8yVDZ4bGJiSVVsbFJQNGh3MGdNQlgwNVkwMU8KSXVXMnNmektjYnE5THE4c0Q1eDlhUytTTHgyeXBvNXlsai9tVXoxandxblBTRkVjNXE1bDBaT0tZcXR2R1ZPRgpoMzRjU3ByK1FRdWltL3lXU05Zays0dTJWZStRYk9lSTJnU213OS9jYjlGU1poTEVUTU1jeVp3aUJtcmluYmovCkVuYUplb0lRWE54ZGxyaE5RN2czcFhWeUJpcVA1bSt5UUl1cVM1N1hNd1grMW9ISnN3NE90YUJ3a0V5bmxCNlMKdEhNWTJwT1JkR0pJQ1pUOFNNWmVNek9RUndKdGFFZ2wzd1hSSVp6bVFBdVNtbUtidWhKNmFxMWYyT01HOGwyWgo5RkdxSTlhbkl0SWc0aGlNVzNVTEx6dkJ1RVgxMERORXI5TG9BTElDODlFemxBeklrZG9NNmNiOFFDM2FESGJKCkdhdjFqMUxBYUxWenRDRlFjbTkwYjI0Z1FXUmtjbVZ6Y3lBOFlXUmtja0JsZUdGdGNHeGxMbU52YlQ2SkFVNEUKRXdFS0FEZ1dJUVFvd3FTdmgwY25pSXAySkIwYWZGNXRIWXpSU0FVQ2F1eHVDZ0liRFFVTENRZ0hBZ1lWQ2drSQpDd0lFRmdJREFRSWVBUUlYZ0FBS0NSQWFmRjV0SFl6UlNPWGRCLzRrb3RBOFh2UVcrREhPL1I4Y0p1U0ZzNDNQCk5UYXlHSVZ1a2owaVNpSG1oQzkzL1JncEd3c0c4QmtJdnIvdTBVVElYTnRDVEdUMjh2T29FQzVIZ1h5VzRpZWEKMVY0Mkc0VjhYZzU3RUFZTzZnYzltelo4U1R3R0dZRktJSEJhUmw5NmNCK3loT1hhVkFPWmQyS05tNDVXcmxwaAp1d2haNXBNcEdXY1lFNmZSMU9yT3hHeTFoZnRQbU14d00rSnpiZ2dMYi8yRGtRTUZrNTRWOUh0SE9idlFic1pTClRuK2pJdUE3azlSUnlSQUFhckF5MEYralFwTm80WS96MmN5Q1lHdlRDZlNBRS9JYmtKZ1V0WjRvVFNucDZLOWsKV1ZnaGVFVlFPaU4zR00yZjdxNXphMXhEVS9JZ1VGbURzQ0RCY0YyNmtzV1grV1pzMzZGdU14SkZBaFRhCj1zaTVJCi0tLS0tRU5EIFBHUCBQUklWQVRFIEtFWSBCTE9DSy0tLS0tCg==',
  shareSec: 'LS0tLS1CRUdJTiBQR1AgUFJJVkFURSBLRVkgQkxPQ0stLS0tLQoKbFFQR0JHcnNiZ3NCQ0FDNGsyY3NUcHcweW5vQk9XcjRSaGdHUzN1bjF1TmhzOUJYL0poWjZHU2dzVTl5RGl2SgpZdTFwc2tjalJQTEx1R0lFendDQWVWdGhxMm01RWlZL0g5SlJ5ZnBqbjF2dEVjQjlNVnhZY2c0Z1RqU1pHdkxnCko0VEw4cUF0OUw4dGJsa1AwY2NiY1FsL3VZNHRWbnZRZVJzRU5hMUVQdXBsa3hRb3g1SnMrQjB6SFoxQ1VlVmMKMXpmeUI2UWNJWDJlcHdJUTMxUVRiejJCZGJvcnBFMjJCendzdERlV3Ayemlxc3lVM3ZCZ3cxL3lqUVd6czJjWgpEZlBiZkVHRWc5NjZZSU1RNVlTUENSNE90WUJ3OVJIeWE0dEVXSzB1UkR2cWRnNHArSjhNb0F2RWNpSmZpOEZ4Cmp0OE1xVC94QVFseHZWVFNMWktnd00rTTBGQk02L2ROSVdpbEFCRUJBQUgrQndNQ0I1QXFtSjZMSXlyL1VjdW0KTzhsS2dMVjRxNnNDWTVYN2RVMmFaaG5MdXkrYjBQdzF6TTFsK0tLWkVwcEpnV3doL3RUc2h6emJpaG1oL0RpdwpWMUVGSktHbHlKaEJ2bUt6VHJDaFNFZGRmd3VWaTFHQ05Hajl0WW1aTHdzcUhRZGFoRXBPajllSUV6N2N3cjNXCnFodDF0VERjdXZtVEJpaENmSU5WQUxoeTNyN1o0UUVHa3VDWlhrd2ZPa0FCNmJwSTNtTlIyWVZCeGZGVnpLUHMKeUF1eHZvTTRWK044bHlYRFJ4YURmSk9UQ1NBNjRJQ0pIVkJyVGpxM1B2RDNaczhiLzhzMUFYQVlzaVJKeDhFUApEYmc1ZlRKT3ROSHN2SnJBNy92OFJIR3JySjJrUEwvdGhQa1lTcFFRWk40ZlpzZ0E4Sng3SFR6K1cwMzdSUFNGCjN4L3piZjV5ZjF4aUY5TTNPMEdkMUk5KzFWaXBWUEJURHlybTl3Y1pjcnVxb1hBZ0tvalhzSExOeVUyanhEeSsKc0QyblNGS1kxUGxGTkM1SnVUdE1oOG9hbWFEZC8yVjhmMU9WUjhpWkR5ZldlS1dnZ0F0aWQ5NjB6cHFadXM5ZApEQVV4Y3lpUUx0YUI3NnFqejQwbDZFMHAxWmtjM2M1UmRZVWx5cUlYUE10cUY4Ri9aMG5Ea0FDWWtHOVpZTVNxClJBMXhJS2hiOEI5WWxHU1NMZDNGdUxuTy9WNGtJK0Q4d3dvUDRoYVBVUzJ5MWMydUprOERWdmJhVndMWG9ubEwKNkRqNVpVaFFrNC9rSEVWQ0JHank4SkxRNDRaOGpseWp4MVdBUXVPbE5NZ3dUMDVnWnhjNWVvaHFaNVozNUwrTgpvbFFGNnQ5ekVlTjB0ZFN0NnY5MitVK1lzS2tkQjFMcWhqU3pIcmZ3d1Y3K2hZS1JzU01hQ3ZJenkzRWRmd1FRCndWUVhyMXpNUTR3azVQeFh5R2dJODlFTDZCUDA4YXd6QzJPcENzaXBsY2dMSE1LOU0xemRNUjhiM0M2WEFzM0EKMDdxc1h0SVZHM3Zoc3pucTFEM1JzbTFtWFpKTG5vTXhWZmlzS3U1ZnVyVFlBdGRSR3dnU2VSbmJpaCtaV1V1VAppV3IrYlgwbW1xLzF2RTZTUmpGVkNmaVBsOFp4RUlNZ1BnWTJOdU42UG9qUHFZN2tnc1F5M21Pa3VSR2pCNS91ClA0ckZKMEh5bityVXRDQlFjbTkwYjI0Z1UyaGhjbVVnUEhOb1lYSmxRR1Y0WVcxd2JHVXVZMjl0UG9rQlRnUVQKQVFvQU9CWWhCSDNrV0FmZVpPR3VtbWw4bVVOd3ZvMjhqQzhSQlFKcTdHNExBaHNOQlFzSkNBY0NCaFVLQ1FnTApBZ1FXQWdNQkFoNEJBaGVBQUFvSkVFTnd2bzI4akM4UitQRUlBS0F6Q3N4MVRBcHJQWW1LM2E2eTBoWHBHYWtWClZZUFo5Z2N0WnJkRDkyZ1ZNd0RnTHppTlUrS080WnZZVVV0YjR0M21meVFNZ1FVTWJGNUROWWJQeWs4c2swbEQKK2t2eU9JVnM4YmZlZjFvMGJxdHR1UWFpODNveS8zUlNtZUQ0d1hkVkhBSm5XWEl3U053SnNBejMxci8xbFU4RQo2RU9QcEMwNWhTZi9MTFVuS1MzMHg0dkwwcDdYeWhUczVQVlZDeW0zMkcva3pLb0ZaM3hzdHlCd29rL1hjQXV5CjN1QWhyemNiMnJrVnVtNHh5ZVBjYXdVdUMvYkNJU1NqMU1kN1V0bnpMdnRQeFduRXlpdDlpRlJwUHRsMlpBcDYKT1QvdEVuOVhXQ2VxNDNJYUxmdW0rdHlyTmM2STVpZ1hzRzRZako5bXo1cGZBRXJmSHZYeG0xTkZCMWc9Cj1pZkNMCi0tLS0tRU5EIFBHUCBQUklWQVRFIEtFWSBCTE9DSy0tLS0tCg==',
  rootSec: 'LS0tLS1CRUdJTiBQR1AgUFJJVkFURSBLRVkgQkxPQ0stLS0tLQoKbElZRWF1eHVEQllKS3dZQkJBSGFSdzhCQVFkQXFtdythSm9PNktUS0VrZUxvY0J1ZXlKd1cvWjQ3ZEU2SnowVQphY3A2SUo3K0J3TUNaQTZBa2VsaWhvZi8zZGZxRHpqSEZmQW5RYW9ReVZ0SDJOYk55WHdMR2NJR1NqaGxZZWlTClZESFNPc1NURy9Cb3BVNE5GN1F1TVc1MmZPUVQ0MDcwMUMxMUdlWHhQMzdKUG9xRnpMYWxvTFFlVUhKdmRHOXUKSUZKdmIzUWdQSEp2YjNSQVpYaGhiWEJzWlM1amIyMCtpSkFFRXhZS0FEZ1dJUVI2ZE53cWRNcDh0Rzh3WTlSYwplNHhRQnRvd0tRVUNhdXh1REFJYkF3VUxDUWdIQWdZVkNna0lDd0lFRmdJREFRSWVBUUlYZ0FBS0NSQmNlNHhRCkJ0b3dLYVd2QVFDZ2pjOWxRMzhBb3J3TlcxR2VWNlV6V1hCRmsydGZPR1FSejdtZ3h1bis0Z0VBbmVZclVSMjEKTy9LMnNDdm1PaGhVdWVYQUJjSWo1N2FHVHhDMjkyVm1wZzJjaXdScTdHNldFZ29yQmdFRUFaZFZBUVVCQVFkQQoyNjE3MGJpUDVNZno5ckRMMDRtNUQ3ZDJSbXE0Ly9RZ0JSam43eEZvcFRjREFRZ0gvZ2NEQXVIQ0ZMREwvYmFXCi95aDlFQkJZdU5McHNWZjhSWlRKR3NRV1g2dkI2ck9OTG1YTlZsK0YxS2k5NGloRDJZamFiYVBROHUwTjVkRVMKWnJ0OTlFNlRGWjl3a3IzaGNXVk5lQUZvYWJVK2ZjQ0llQVFZRmdvQUlCWWhCSHAwM0NwMHlueTBiekJqMUZ4NwpqRkFHMmpBcEJRSnE3RzZXQWhzTUFBb0pFRng3akZBRzJqQXBPWVVCQUtscVBUMWVqdWpaZGNsVmxXaFd0b3dhCkc5TjM5YWg4c2VCbGRyWmRqSmVqQVA5TjJvVlRqTmExMjVlSUw2NDdoWTlKK3ZnOUUvaEltR3lDS3hENUNOVEEKQmc9PQo9Q3ZBMAotLS0tLUVORCBQR1AgUFJJVkFURSBLRVkgQkxPQ0stLS0tLQo=',
  fileSec: 'LS0tLS1CRUdJTiBQR1AgUFJJVkFURSBLRVkgQkxPQ0stLS0tLQoKbFFQRkJHcnNicDBCQ0FDOG0xR0licjEwNEhkSVZqbWtKZDRLQ0RnNTMyRVUrMEZwc0tTdGUwS0dPQWM4ZmZXRQpHaDI5WENRQUlrU0VFZ2Z0T0kvM1lFVzlXTUxYZ2NsR2VNLytqbHBuMVFacFllRWRvd013OEVURmFOcDVMZU92CitIZHhHSmdZWDFwZ3o1Njl2SytQbDQrKy8wR1F0RUFOUDdhQzBNYU1sUXpmMGt3N0RhdUFZcFA1TzJHWmpoOUIKWURiUVJtQzVYam95SFRKaFJQSjQ1UmhCNXlIemFhWG5pZ1UzYmFtQU5wWFVmQXVnUDA3VU1ONDQxQXpnOVZpLwpjQWtOUENSc3ZSY1QrQS9WRjhYZjkrR0tiVGpBTU42YldNdk16S3VwS1BxelErZ2hycnJma1dSbG1BNzNMZ1JnCnU0QnU5SGdVVE9ZVkhUWEpFVkJmWTZCUktmYzRpa1FXcGtOWEFCRUJBQUgrQndNQ2FFK2F1S0VzZnFYL3pCMUQKY1lHVmgySDh6UjFYT1U3Vk14bGhDbThONlRrSkRHOGl4YnpaRkNYeW9ZcVZhbCtVMlFISFZNNzdVeWE5ajROVQpGeS9uSDBvUlZSRnRkUDVDL1M2cFEwSXh1RXVsUjVoMDJTMXNQNFNOUnVTd2k0SGxVN3R1ZmJlTnZOVkhHcWFrCkFSbWJYSmVmVkxGTHU4TTBoSjhvcFZOVmgyN3k4a0prMEVGMnNNYlF1bkRwMHkrYlVDbmFKNUFkNTN5c29oR1cKRzJKMGlWUW1hcnRzdTVhWi8vdURQbm9MNUlIYWd3dDRXenB3NEQ0ZUxlbkFZbXJQT1diSk9aN1J1dlF1M25KawpPS2R4YjluY2pubkRzUEtBOTNpZXM1V0ZFbitnNWUrVytHdm9qWVpjQVpsa3VYWGE4VmRtRGJOM254Vkh4Z241CmhXMnpMUnk3OFBtR1FtWDNRSERQVmNubDM4T3FXb3VkQ0hrVHN6YUVoZnl1OW5GSmE2b2N4cmNLcWNiM2RaeXYKejNIYzA1NjJMcTVFdXA5Y1BuS2pkSXhXUXM4bHZxTUlkd1B2VWdaOHJST05rL0hvRGhHTmVTWTdaRFdHeEprcgprcGRseE1INWhteUVBMkU4S2psdndGc2xlS1M2U2hpMi82bGxRakdsenluVFJPaEhXRUxBc0NyUGlMZUdwRWpoCndiRC9OWFE2WFlUY0t0anU4VmZVSTBwN0duY0t1TXJETHo1STJpV0ZMVlVnOC9QQkd5T2JuVE9xTFZOeXFpQVoKanNFaEc0QXhGai81VUI4a0lZZzZiUG9lT21ETzlQZUFxNVdNcjJQUkJmek1QSk9DS1l3ZHByUFQyeWtpZDVPSQpNUElxWHVYV2dNRW1wLzhlTEdTSXBpcmQvc2RlU29kTm96cFZvbTlydUZQekZOOGhUNGtZaE5TRHFORXo5clBjCkJMOXFLMmhZOHVYOW40NXRJMlhDVktXT1BsMzhNeWNicVEvSDBRTG5NQ0pNWXhEV3ZYcXFCZVhlcVFsWGlYbk0KK2JaWk05SW1vWGc3RC9ITXpUM1ZSY3E3WEtxa0xUQ2ZKY29VU0FvbjVKZ1M5eXpjM1QrYlI0aERwRkk1Z1RmaApUeDN6bnJmQlA1S09pb0xWQVkyYjd5Q0NDVVV2QXRyMXE5Mkl5aTF4cFBDcTRLN0Z5UER5dnFFdWIxLzFnTDdqCkhRT2JtMnZ4VHJxMEhsQnliM1J2YmlCR2FXeGxJRHhtYVd4bFFHVjRZVzF3YkdVdVkyOXRQb2tCVGdRVEFRb0EKT0JZaEJEakJNMGRLaExzNjlyNmVCRG5WWi9pc1IxSVBCUUpxN0c2ZEFoc05CUXNKQ0FjQ0JoVUtDUWdMQWdRVwpBZ01CQWg0QkFoZUFBQW9KRURuVlovaXNSMUlQb0RJSC9SbFZ3czJXbVJKU1FXY3ZzOHpXbVJ1NUEzNzZsWXVwCitVYVBFSVkzUFRnVXdDRGpMNyswbHFNcTRCMHM1WFJRTHVxNTNXVTRTQ3o2R3dUcWlUQU8vUnA1OG5CL3FxVzkKMFlKVUJoMW5WMmo5UU55aGdPZ0wwRkJiZnlkamNPanlxOFhZWVM1Tkt0T3pxbGpOTm5ITzJhN0krdExsK1lQQgowSDhVZUowV1VtbFlDVnFZRDkxMEhlKy9idDg2UW1EYU9XU2Q3dG90SzFkdXBGcVoyZlgzK2wrWnZpTUJUS3lTCkFEU0hQZEdvNCt0T1Q1MnpZN3hPQnRmYmJxdHpyS1h5YTVNeFZmWXArQ3FRK2R0RWlLMEdVQVFlQ3VnRzhWUloKNy9nSDNSMHFZVjZlMWFJM0RIcnI0SE9BSXF2R2xtcmhZMGJTMmVKTlg4cmJnaDByeEp4ZG91UT0KPS8vOWkKLS0tLS1FTkQgUEdQIFBSSVZBVEUgS0VZIEJMT0NLLS0tLS0K',
  token: 'LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0tCgpoUUVNQSt1aVJhNTd6RDN4QVFmL1ZPMUtncEFyQk44MmJ6eHE4MWl4ZW5yaTJEVi9UV3VFczJXeWk5UjkzRjUzCmJCMjMvcllzRCtDRWZpT2R2RHo0QU5KM0VLNkNXMHUxbnVaME9VSjdNVVNkS3UrdDZiVW1NSmsxNmRsTHRQTzkKc3dYZFZCVTJLaE5IeDVxTzVTOUt0Smh3emIyS3dveW8vTkI3bmtRYUo1dHJ4WU10WGhkQ2MrZkoydFVyRStybApjeE5uQ2EzMVVHMmprWjZaQ2xTNkg1ZDRHOEFLUmJPeWQ4bWRLdDg5QXV3aURqWHMwR2x1T3VqNzc2MjFLaDZxClY4cFMwcVI5LzgzOVhPYTJBU2d4SDcyeTlneExnNHNwald6QW11cmhDSXpRV3lkRzd2WmJncmNtSzRxYS9FeVEKZzJNek9tcTNTVDN2cDYvbEE4aUhKT0I4ZlgzSyt3bDM3VHZGRmxYcVQ5SkVBUnFlTXg1bDdLYkhmVU9aTnpidQpibGZEOEIzUEQzZllpUlRNcG51eEdrQ0c5R0tLMjMxQW5KQ1pyd1llUWR2dzBGWE9BVUxRWVY2U2dYSjI1Ti9ZCjdXSmlDVms9Cj1ZR2dqCi0tLS0tRU5EIFBHUCBNRVNTQUdFLS0tLS0K',
  sharePass: 'LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0tCgpoUUVNQXhwOFhtMGRqTkZJQVFmL2JrZk1FS2ZuTms3aDJJZkFtb1lJUDI0SFR0S1JDNjlaeWJwdGdURStHT2VRCnZkT2JGV2JQOEhyb3dldTVIL1pRakVYdFhiWEMvTGFXcEVlMVU3eGFNdC9iT1VZK1l2TGovUnlmc3NSNXJGUTEKVWRnZGNtR0lTS0R4VG5aWE5mQnN3aDlQOE9RSHhBcWpVb0E3V3ZDSzIwM3FjMFF6MkRsVXI1UU9JalhPYXpLbApMNmE0Y2tJVTc3bTJ3NjRtbUhIRnNxenZYaUxvN3d4dWxIM3F6V2U0aHVERExiN1RUOVB0YUM2NGtkWUxuUVExCk9ycVZQYWh0by92eWlNaklBSm5ZTWZwV2tlb1NidzlnRm9HWGxPdGpxYzZia0ZkUnhhejRrOUNQSElhNjhoYTIKb3htRlRHZDRrdEE0RjNHbHRMWHM4MUNjYTFDY2FNZjVVcUFFeXpMaTZ0SkZBVkgwZGFGQXdDZ0w2MkhBK2FCeApFMEtEYkYvZ1I3dkhWT0hvNFdVZ0U0dk1oRGU4NDdVc2JBLy9lM3hXdWJjbmpwcjZmaENFN2hUOVBscndJZmZpCkV0bHBlSnlUCj02WG56Ci0tLS0tRU5EIFBHUCBNRVNTQUdFLS0tLS0K',
  rootNodePass: 'LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0tCgpoUUVNQTBOd3ZvMjhqQzhSQVFmL1VMaW1tRm5RVW85QnVRRXR0RjJCOGc5OHJ1Zm51Vy8vWWtCYXgzTTRycVkvClVHNGxqT3hTL0t4eDdPYXlPa1B5Rm91bDRaREV6WWtqcXNSbXRKbCs0aEZVZGZzUEVUTGdOQm1GMEZOWENobkMKMlAxby9sUmozdUpWRjk1RFRVbnZRTjdVcHRlZzhkRHNwNXVIZlN6dWRFY0U0cU1uQWFEdVVtejlrVllXeTcxZQpkTGwrdWswU1UvcHlqQ0c5VFdmbm9ETEVEWDhtamJuZ1NWT2hsVEN2blpCQ0FPOHZpaTlDSEFwamx2dllIdHNRCm5YSStrTnl0MXdpUVcxSEFSTU96N0dLMVh4cGkvZ2J4NXRXT0d6L1Eza3ZzWWlHVXdQRXBBOStOc2d6RjNFaWkKdDZNT1REL2x6eVQ3T3A4YzRWbUVsdkZzYVVPSDRaOHVaTjBuUXY1Q2E5SkpBVFAzVU5KWWtBNWRtVmRkNUUrVwpLb0lKcFpPRS9GOXFKYVJobGl2Z252UkZkWmZpMlFCeWNFNUtPMGFDbEgyVnhGc3hqMDV1ams3U2xadHlLazVOCldFaTRWUk1DM0ZwNmJRPT0KPWFKdEIKLS0tLS1FTkQgUEdQIE1FU1NBR0UtLS0tLQo=',
  rootName: 'LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0tCgpoRjREWHVlS0tQQXYwVElTQVFkQUl5K0NHZTRzT3Q2eHFIM3dlblBwVGZNZ0lwZHg4OUw3eHVkMDNPSEc3eWd3ClpaZkNXM3c4NllVQi9DY3NwVHR2SXZBaXRURkwzaHJ3cko1Qmo0QUNha1BZaVBneHZSOHo3MkRWWTV1NXl5OGkKMGo4QjZYVVhWVStUeFIraEE2bUNtRmhFTkZUSDUrOUV6M2VvcnVJTTVRWG5hRjE1S0sra1hWRjJDTmZjN3dCawpsemFTMHFweTNNV3ByS2pYR0tQQlpsaz0KPUJJL3oKLS0tLS1FTkQgUEdQIE1FU1NBR0UtLS0tLQo=',
  fileNodePass: 'LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0tCgpoRjREWHVlS0tQQXYwVElTQVFkQXJrSlV1RS80ZWdPMWk1UzR1QnZtOGx3ajM2MzZYSUt3YUtzYW5DNVZvSG93CkRwK2hQeFRCMk1DYTdjQzVzSHJMT3AzektXNDBueE5yNnQzSXQzZUg0Tk81aXd2cDg5WE90UTRmR3c0MVN4TjkKMGtRQkFmQ1RISE1hdWlMcnR0NDFwRER2NUFHVEV4THl6Y2duVXlXZkkvMlJxSlU0ZGhNRXNFek5lTjExa2dJZQp6ZkcxckI1cmlUeC91THRkY2NPMDg1L0h0Q3MwNnc9PQo9LzNOegotLS0tLUVORCBQR1AgTUVTU0FHRS0tLS0tCg==',
  fileName: 'LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0tCgpoUUVNQXpuVlovaXNSMUlQQVFmK0xlbEF5NTZ2MnhqSFlVQWhhOGg0TEVBdkNpb29hTEJFSGR3bnRUdGd6QUxFClJSdTFKVVBrSDhsZkZVS1RBeUErN3BFNUtORnYzOFB5VU5OcEpxOHVrMzZNTXhmcmlzODZ2NlYrQk1aNjlpR1EKZkJocjdtSC9ad3pkRFZsS1U4RkNSVWtoQ3ArWklZNXd0OE5tdC9xNUxQUEpVVGFVRGFhMjkrTVlEOENVMGJuWApOYy80ZGRNKy8vODJBSDU5K01KWTcweHVadldlMmlqTDgrWEJDTWpEeE9yTVplTkNDZTJIMzFQTFV5aE5yWWR4CjV4TElBMUlFR3EwVUIwQnVacENpVEpJWDVrdm5lQlh6ckM2cW0xcmpOWEZRWmozdmx1MkRFTjV1VHBBcFdJSzAKYlcweTc2T2dNQzE0cVJnR3Q5QUZNQzVQd0ZyZURoM1crVldOSUcyN2V0SkVBWWhGb3JEcGJTRUIxR3JNcVV2NApRMlJzeTZrV24rUWJIVkl2aDVqL0RPdlU2c0VtNFpxNWQ0bmNub1dCSmdpTEM4YkMzQkI4aWpMRUd5cHByMThxCm1VZklMb0k9Cj16enJXCi0tLS0tRU5EIFBHUCBNRVNTQUdFLS0tLS0K',
  xattr: 'LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0tCgpoUUVNQXpuVlovaXNSMUlQQVFnQWtGK1NZNTVwNzU1YVViUFNzY0k1bEJ0ampGMDc2T0xMb3RWOFdDNDVDQTRPCkFwd3dhSDRpcEZUaXkrdUM0eTRoSlJ0YWhZcCtqdklIczRld3VBeHh1cUV4N0J6UlpUVzVhQ1J3SXZUUXVGZm4KSng2dm9YdDlSTDM3c040dmZ5Nk9UNGpzQ0c1TERuMmxheXMyMTM5VmdheHJ1VU1PaHR1YzVNMk1FY2lzdjJoNgpmSDRjdmZjaFFKWXF0eno0dVl0STZWWS9HSHlUc01MMzI2OFRqSnhUaElqeFJlaDFOODh1UzZsdmc0b2hCbDFZCjZJcFh0RTdya1F2eE1ma24wemhUZ1AwSFVNbC9OZURGdFBhWVMrdWpHRGJSRmhRaVhqclk0TGErdVFhWHdoQWkKTGFtUytVWEJuOWJnTnZFQzE4SUZQTmduaXNmWDU4TEJjc3ltMml6WEtkSTlBWCtMdEs2VUR2MUNBTFhGTVdZcwpkTm13SlNNNHNiRXVrWVhuT1I1TnhaejB4MEpVMS83ZmplZGs5N0drcHFJc0d5UE9zSktTbTgwd2l4bUoxUT09Cj1YN0o3Ci0tLS0tRU5EIFBHUCBNRVNTQUdFLS0tLS0K',
  pkesk: 'LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0tCgp3Y0JNQXpuVlovaXNSMUlQQVFmL2RqbWpWVXRvSGJRaFlIUlBXQzJTZVlXNVdPOTZ1NDBwelV2SUdXc1kvcEZMClh3a0E5OVhCa1BBSjI1bGpwc2lkRlRtOStQKzRyK3lTRVR1Sis4ekpNNzJGbDlhUk9hdGVKTkp5Wm5YMDljeXgKZEhRVTVuN1Bha3VHQU5NQ3BJSE9qZCtuVnlLQkVjSGI4MFVNUUdRMGcycGVQZUY5QXFKd2pFZDEySEFVdUtxbQoyQm5LUmZER0tzNTVxcjN4YUo0Nittc1JNT3UwVVFNU0JYZlBIYWVVVkR1dGd6RlBIZWlXcG5tcTJ3VHpsN0MvCkhiTGJCV0xEVGJQeWdxMm81N05lMENVZllHLzU1NmsxeDBPV3lLU0dJMXBYVm5pSTJ0NDg5QWFZZ0NVYjhsQmYKcGJyemQyMGRCS2M2bWZoM2JwVVIwMkZtVEZud25PTWNDYnFMOHQ4bW93PT0KLS0tLS1FTkQgUEdQIE1FU1NBR0UtLS0tLQo=',
  block: 'hQEMAznVZ/isR1IPAQf/djmjVUtoHbQhYHRPWC2SeYW5WO96u40pzUvIGWsY/pFLXwkA99XBkPAJ25ljpsidFTm9+P+4r+ySETuJ+8zJM72Fl9aROateJNJyZnX09cyxdHQU5n7PakuGANMCpIHOjd+nVyKBEcHb80UMQGQ0g2pePeF9AqJwjEd12HAUuKqm2BnKRfDGKs55qr3xaJ46+msRMOu0UQMSBXfPHaeUVDutgzFPHeiWpnmq2wTzl7C/HbLbBWLDTbPygq2o57Ne0CUfYG/556k1x0OWyKSGI1pXVniI2t489AaYgCUb8lBfpbrzd20dBKc6mfh3bpUR02FmTFnwnOMcCbqL8t8mo9JHAbuy8AGu5fYkbr3GgZMgCz2TxDEIajPP/2ARLEbnuvvMMCzpE+kyoIoaB2fx/ALOnGpJgXamG1Me1F8R9XGlHxBh3LcnKsk='
}

const utf8Decoder = new TextDecoder()

function armor(name: string): string {
  return utf8Decoder.decode(base64ToBytes(FIXTURES[name]!))
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

const USER_SEC = armor('userSec')
const ADDR_SEC = armor('addrSec')
const SHARE_SEC = armor('shareSec')
const ROOT_SEC = armor('rootSec')
const FILE_SEC = armor('fileSec')
const TOKEN = armor('token')
const SHARE_PASS = armor('sharePass')
const ROOT_NODE_PASS = armor('rootNodePass')
const ROOT_NAME = armor('rootName')
const FILE_NODE_PASS = armor('fileNodePass')
const FILE_NAME = armor('fileName')
const XATTR = armor('xattr')
const CONTENT_KEY_PACKET = armor('pkesk')
const BLOCK_BYTES = base64ToBytes(FIXTURES.block!)

const REUSABLE = base64Of(JSON.stringify({
  UID: 'UID1',
  AccessToken: 'access-token',
  RefreshToken: 'refresh-token',
  SaltedKeyPass: base64Of('user-pass'),
}))

function base64Of(value: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function ok(body: unknown): Response {
  return json({ Code: 1000, ...(body as Record<string, unknown>) })
}

interface FixtureOverrides {
  usersStatus?: number
  revisionsStatus?: number
  refreshStatus?: number
  missing?: boolean
}

interface Captured {
  url: string
  method: string
  headers: Headers
  body: string
}

function stubProton(overrides: FixtureOverrides = {}): { fetch: typeof fetch; calls: Captured[]; blockCalls: Captured[] } {
  const calls: Captured[] = []
  const blockCalls: Captured[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url, method, headers, body })
    if (url === 'https://block.example/0') {
      blockCalls.push({ url, method, headers, body })
      return new Response(new Uint8Array(BLOCK_BYTES))
    }
    const parsed = new URL(url)
    const path = parsed.pathname
    if (path === '/api/auth/info') return json({ Modulus: MODULUS, ServerEphemeral: SERVER_EPHEMERAL, Salt: AUTH_SALT, Version: 4, SRPSession: 'sess' })
    if (path === '/api/auth/v4') return json({ Code: 1001, TwoFactor: { Enabled: 1 } })
    if (path === '/api/auth/v4/2fa') return ok({ AccessToken: 'access-token', RefreshToken: 'refresh-token', UID: 'UID1' })
    if (path === '/api/auth/v4/refresh') return overrides.refreshStatus ? new Response('no', { status: overrides.refreshStatus }) : ok({ AccessToken: 'access-token', RefreshToken: 'refresh-token', UID: 'UID1' })
    if (path === '/api/core/v4/keys/salts') return ok({ KeySalts: [{ ID: 'USERKEY1', KeySalt: 'AAAAAAAAAAAAAAAAAAAAAA==' }] })
    if (path === '/api/core/v4/users') {
      if (overrides.usersStatus) return new Response('denied', { status: overrides.usersStatus })
      return ok({ User: { ID: 'USER1', Name: 'owner', Email: 'user@example.com', Keys: [{ ID: 'USERKEY1', Primary: 1, PrivateKey: USER_SEC }] } })
    }
    if (path === '/api/core/v4/addresses') return ok({ Addresses: [{ ID: 'ADDR1', Email: 'addr@example.com', Keys: [{ ID: 'ADDRKEY1', PrivateKey: ADDR_SEC, Token: TOKEN }] }] })
    if (path === '/api/drive/shares') return ok({ Shares: [{ ShareID: 'SHARE1', VolumeID: 'VOL1', RootLinkID: 'ROOTLINK', Type: 1, AddressID: 'ADDR1', Key: SHARE_SEC, Passphrase: SHARE_PASS }] })
    if (path === '/api/drive/volumes/VOL1/links/ROOTLINK') {
      if (parsed.searchParams.get('Children') === '1') return ok({ Links: [fileLink()] })
      return ok({ Link: rootLink() })
    }
    if (path === '/api/drive/volumes/VOL1/links/FILELINK') return ok({ Link: fileLink() })
    if (path === '/api/drive/volumes/VOL1/links/FILELINK/revisions') {
      if (overrides.revisionsStatus) return new Response('missing', { status: overrides.revisionsStatus })
      return ok({ Revisions: [{ ID: 'REV1', Size: 12, State: 1, Blocks: [{ Index: 0, BareURL: 'https://block.example/0', Token: 'block-token' }] }] })
    }
    if (path === '/api/drive/volumes/VOL1/links/FILELINK/trash') return ok({})
    if (path === '/api/drive/shares/SHARE1/folders') return ok({})
    if (path === '/api/drive/volumes/VOL1/links/FILELINK/rename') return ok({})
    throw new Error(`unexpected Proton request: ${method} ${url}`)
  }
  return { fetch: fetch as typeof fetch, calls, blockCalls }
}

function rootLink(): Record<string, unknown> {
  return {
    LinkID: 'ROOTLINK', Type: 2, Name: ROOT_NAME, NodeKey: ROOT_SEC, NodePassphrase: ROOT_NODE_PASS,
    ModifyTime: 1700000000, CreateTime: 1700000000,
  }
}

function fileLink(): Record<string, unknown> {
  return {
    LinkID: 'FILELINK', ParentLinkID: 'ROOTLINK', Type: 1, Name: FILE_NAME,
    NodeKey: FILE_SEC, NodePassphrase: FILE_NODE_PASS, Size: 12,
    ModifyTime: 1700000100, CreateTime: 1700000100, XAttr: XATTR,
    FileProperties: { ContentKeyPacket: CONTENT_KEY_PACKET },
  }
}

// A small non-degenerate SRP modulus is enough: the test asserts the wire parameters, not the
// server-side verification.
const MODULUS = base64OfBytes(hexBytes('0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'))
const SERVER_EPHEMERAL = base64OfBytes(new Uint8Array([2]))
const AUTH_SALT = base64OfBytes(new Uint8Array(16))

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index++) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return out
}

function base64OfBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    reusableCredential: REUSABLE,
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'proton_drive',
    config: { email: 'user@example.com', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Proton Drive driver', () => {
  it('lists decrypted names through the full key chain', async () => {
    const stub = stubProton()
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createProtonDriveDriver(context())

    const result = await driver.list('/')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ name: 'hello.txt', kind: 'file', size: 12, ref: 'FILELINK' })
    expect(result.truncated).toBe(false)
    expect(stub.calls[0]!.headers.get('authorization')).toBe('Bearer access-token')
    expect(stub.calls[0]!.headers.get('x-pm-uid')).toBe('UID1')
  })

  it('decrypts the real OpenPGP content key, XAttr and SEIPD block on read', async () => {
    const stub = stubProton()
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createProtonDriveDriver(context())

    const stat = await driver.stat('/hello.txt')
    expect(stat).toMatchObject({ name: 'hello.txt', kind: 'file', size: 12 })

    const response = await driver.read('/hello.txt')
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.headers.get('content-length')).toBe('12')
    expect(await response.text()).toBe('hello proton')
    expect(stub.blockCalls[0]!.headers.get('authorization')).toBe('Bearer block-token')
  })

  it('marks the storage for re-authorization when the session is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    const stub = stubProton({ usersStatus: 401, refreshStatus: 401 })
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createProtonDriveDriver(context({ markNeedsReauth: mark }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit without asking for re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    const stub = stubProton({ usersStatus: 429 })
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createProtonDriveDriver(context({ markNeedsReauth: mark }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(mark).not.toHaveBeenCalled()
  })

  it('maps a 404 upstream response to not_found', async () => {
    const stub = stubProton({ revisionsStatus: 404 })
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createProtonDriveDriver(context())

    await expect(driver.read('/hello.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('rejects an escaping path before any HTTP call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createProtonDriveDriver(context())

    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.rename('/docs/../escape', 'x')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the SRP proof and the 2FA code with the session identifier', async () => {
    const stub = stubProton()
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createProtonDriveDriver(context({
      credentials: { reusableCredential: '', password: 'proton-pass', twoFaCode: '123456' },
    }))

    await driver.list('/').catch(() => undefined)
    const auth = stub.calls.find((call) => call.url.endsWith('/auth/v4'))
    const twofa = stub.calls.find((call) => call.url.endsWith('/auth/v4/2fa'))
    expect(auth).toBeDefined()
    const authBody = JSON.parse(auth!.body) as Record<string, unknown>
    expect(authBody.Username).toBe('user@example.com')
    expect(typeof authBody.ClientEphemeral).toBe('string')
    expect(typeof authBody.ClientProof).toBe('string')
    expect(authBody.SRPSession).toBe('sess')
    expect(twofa).toBeDefined()
    const twofaBody = JSON.parse(twofa!.body) as Record<string, unknown>
    expect(twofaBody.TwoFactorCode).toBe('123456')
    expect(twofaBody.SRPSession).toBe('sess')
  })

  it('asks for the twoFaCode credential instead of retrying when 2FA is enabled', async () => {
    const stub = stubProton()
    vi.stubGlobal('fetch', stub.fetch)
    const mark = vi.fn(async () => undefined)
    const driver = createProtonDriveDriver(context({
      credentials: { reusableCredential: '', password: 'proton-pass' },
      markNeedsReauth: mark,
    }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('twoFaCode') })
    expect(stub.calls.some((call) => call.url.endsWith('/auth/v4/2fa'))).toBe(false)
  })

  it('creates a folder and renames a file with OpenPGP encryption', async () => {
    const stub = stubProton()
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createProtonDriveDriver(context())

    await driver.mkdir('/docs')
    const created = stub.calls.find((call) => call.url.endsWith('/drive/shares/SHARE1/folders'))!
    const body = JSON.parse(created.body) as Record<string, string>
    expect(created.method).toBe('POST')
    expect(body.ParentLinkID).toBe('ROOTLINK')
    expect(body.Name).toContain('BEGIN PGP MESSAGE')
    expect(body.NodeKey).toContain('BEGIN PGP PUBLIC KEY BLOCK')
    expect(body.NodePassphrase).toContain('BEGIN PGP MESSAGE')
    expect(body.Hash).toBe(base64OfBytes(sha256Bytes('docs')))
    expect(body.SignatureAddress).toBe('ADDR1')

    await driver.rename('/hello.txt', 'renamed.txt')
    const renamed = stub.calls.find((call) => call.url.endsWith('/links/FILELINK/rename'))!
    const renameBody = JSON.parse(renamed.body) as Record<string, string>
    expect(renamed.method).toBe('PUT')
    expect(renameBody.Name).toContain('BEGIN PGP MESSAGE')
    expect(renameBody.Hash).toBe(base64OfBytes(sha256Bytes('renamed.txt')))
    expect(renameBody.OriginalHash).toBe('')
  })

  it('trashes a resolved node and keeps upload/move/copy unsupported', async () => {
    const stub = stubProton()
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createProtonDriveDriver(context())

    await driver.remove('/hello.txt')
    expect(stub.calls.some((call) => call.url.endsWith('/trash') && call.method === 'POST')).toBe(true)
    expect(driver.capabilities).toMatchObject({ read: true, write: false, mkdir: true, rename: true, move: false, copy: false, delete: true, directLink: false, range: false })
    await expect(driver.upload('/x.bin', new Uint8Array(0), { size: 0 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.move('/hello.txt', '/other.txt')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(await driver.directLink!('/hello.txt')).toBeNull()
  })
})

function sha256Bytes(value: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value).digest())
}
