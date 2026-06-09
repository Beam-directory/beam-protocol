import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicDirectoryForEvidence, isLoopback } from './external-dogfood-pack.mjs'

test('external dogfood pack identifies loopback directories', () => {
  assert.equal(isLoopback('http://localhost:43100'), true)
  assert.equal(isLoopback('http://127.0.0.1:43100'), true)
  assert.equal(isLoopback('https://api.beam.directory'), false)
})

test('external dogfood release evidence guard rejects localhost packs', () => {
  assert.throws(
    () => assertPublicDirectoryForEvidence('http://localhost:43100', true),
    /non-local Beam directory/u,
  )
})

test('external dogfood release evidence guard accepts public directories', () => {
  assert.doesNotThrow(() => assertPublicDirectoryForEvidence('https://api.beam.directory', true))
  assert.doesNotThrow(() => assertPublicDirectoryForEvidence('http://localhost:43100', false))
})
