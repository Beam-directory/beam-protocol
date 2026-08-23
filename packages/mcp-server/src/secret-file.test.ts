import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { requiredSecret } from './secret-file.js'

function withSecretFile(value: string, run: (file: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'beam-mcp-secret-'))
  const file = join(directory, 'secret')
  writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 })
  try {
    run(file)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('loads a mounted secret file without exposing the file path as the value', () => {
  withSecretFile('mounted-secret\n', (file) => {
    const value = requiredSecret({ BEAM_API_KEY_FILE: file }, 'BEAM_API_KEY')
    assert.equal(value, 'mounted-secret')
    assert.notEqual(value, file)
  })
})

test('rejects ambiguous, relative, non-file, and oversized secret sources', () => {
  withSecretFile('file-secret', (file) => {
    assert.throws(
      () => requiredSecret({ BEAM_API_KEY: 'direct', BEAM_API_KEY_FILE: file }, 'BEAM_API_KEY'),
      /only one/,
    )
  })
  assert.throws(
    () => requiredSecret({ BEAM_API_KEY_FILE: 'relative-secret' }, 'BEAM_API_KEY'),
    /absolute path/,
  )
  assert.throws(
    () => requiredSecret({ BEAM_API_KEY_FILE: tmpdir() }, 'BEAM_API_KEY'),
    /readable regular file/,
  )
  withSecretFile('x'.repeat(65 * 1024), (file) => {
    assert.throws(
      () => requiredSecret({ BEAM_API_KEY_FILE: file }, 'BEAM_API_KEY'),
      /between 1 byte and 64 KiB/,
    )
  })
})
