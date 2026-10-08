import { describe, expect, it } from 'vitest'
import { isRetryableDirectoryError } from '../src/retry.js'

describe('directory retry classification', () => {
  it('does not retry an approval hold', () => {
    expect(isRetryableDirectoryError('APPROVAL_REQUIRED', 202)).toBe(false)
    expect(isRetryableDirectoryError(undefined, 202)).toBe(false)
    expect(isRetryableDirectoryError('OFFLINE', 503)).toBe(true)
  })
})
