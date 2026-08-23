import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const MAX_SECRET_BYTES = 64 * 1024

export function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const direct = env[name]?.trim()
  const fileName = `${name}_FILE`
  const file = env[fileName]?.trim()

  if (direct && file) {
    throw new Error(`Set only one of ${name} or ${fileName}`)
  }
  if (direct) {
    if (Buffer.byteLength(direct, 'utf8') > MAX_SECRET_BYTES || direct.includes('\0')) {
      throw new Error(`${name} is invalid or exceeds 64 KiB`)
    }
    return direct
  }
  if (!file) {
    throw new Error(`Missing required secret: set ${name} or ${fileName}`)
  }
  if (!isAbsolute(file)) {
    throw new Error(`${fileName} must be an absolute path`)
  }

  let size: number
  try {
    const stats = statSync(file)
    if (!stats.isFile()) throw new Error('not a regular file')
    size = stats.size
  } catch {
    throw new Error(`${fileName} must reference a readable regular file`)
  }
  if (size < 1 || size > MAX_SECRET_BYTES) {
    throw new Error(`${fileName} must contain between 1 byte and 64 KiB`)
  }

  let value: string
  try {
    value = readFileSync(file, 'utf8').trim()
  } catch {
    throw new Error(`${fileName} must reference a readable UTF-8 file`)
  }
  if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new Error(`${fileName} contains an invalid secret`)
  }
  return value
}
