export interface Http01Instruction {
  recordName: string
  recordValue: string
  path: string
}

export function http01Instruction(token: string, keyAuthorization: string): Http01Instruction {
  const path = `/.well-known/acme-challenge/${token}`
  return {
    recordName: path,
    recordValue: keyAuthorization,
    path,
  }
}
