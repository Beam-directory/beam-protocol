import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const braces = require('./index.js')

test('keeps ordinary compile and expand behavior', () => {
  assert.deepEqual(braces('a/{b,c}/d'), ['a/(b|c)/d'])
  assert.deepEqual(braces.expand('a/{b,c}/d'), ['a/b/d', 'a/c/d'])
  assert.deepEqual(braces.expand('./src/**/*.{js,ts,jsx,tsx}'), [
    './src/**/*.js',
    './src/**/*.ts',
    './src/**/*.jsx',
    './src/**/*.tsx',
  ])
})

test('rejects deeply nested patterns instead of overflowing the stack', () => {
  assert.throws(() => braces('{'.repeat(101) + 'a,b' + '}'.repeat(101)), /exceeds max depth/)
  assert.throws(() => braces('('.repeat(101) + ')'.repeat(101)), /exceeds max depth/)
})

test('still accepts nesting at the guard limit', () => {
  assert.doesNotThrow(() => braces('{'.repeat(100) + 'a,b' + '}'.repeat(100)))
})

test('reports a version outside the vulnerable range', () => {
  assert.equal(require('./package.json').version, '3.0.4')
})
