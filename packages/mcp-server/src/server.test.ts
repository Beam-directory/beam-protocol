import test from 'node:test'
import assert from 'node:assert/strict'
import { assertBeamMcpScope } from './server.js'

test('stdio mode does not require OAuth scopes', () => {
  assert.doesNotThrow(() => assertBeamMcpScope(undefined, 'beam:send'))
})

test('remote mode keeps read and send scopes separate', () => {
  const readOnly = new Set(['beam:read'])
  assert.doesNotThrow(() => assertBeamMcpScope(readOnly, 'beam:read'))
  assert.throws(
    () => assertBeamMcpScope(readOnly, 'beam:send'),
    /OAuth scope beam:send is required/,
  )
})
