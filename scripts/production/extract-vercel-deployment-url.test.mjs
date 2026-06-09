import test from 'node:test'
import assert from 'node:assert/strict'
import { extractVercelDeploymentUrl } from './extract-vercel-deployment-url.mjs'

test('extracts the last Vercel deployment URL from deploy output', () => {
  const output = [
    'Vercel CLI 50.38.1',
    'Inspect: https://vercel.com/alfridus1s-projects/dashboard/abc',
    'Preview: https://dashboard-old-alfridus1s-projects.vercel.app',
    'https://dashboard-current-alfridus1s-projects.vercel.app',
  ].join('\n')

  assert.equal(extractVercelDeploymentUrl(output), 'dashboard-current-alfridus1s-projects.vercel.app')
})

test('extracts a deployment URL from JSON output', () => {
  const output = JSON.stringify({
    url: 'https://dashboard-current-alfridus1s-projects.vercel.app',
  })

  assert.equal(extractVercelDeploymentUrl(output), 'dashboard-current-alfridus1s-projects.vercel.app')
})

test('extracts nested deployment URL fields from JSON output', () => {
  const output = JSON.stringify({
    deployment: {
      url: 'dashboard-current-alfridus1s-projects.vercel.app',
    },
  })

  assert.equal(extractVercelDeploymentUrl(output), 'dashboard-current-alfridus1s-projects.vercel.app')
})

test('ignores non-deployment Vercel dashboard URLs', () => {
  const output = 'Inspect: https://vercel.com/alfridus1s-projects/dashboard/abc'

  assert.equal(extractVercelDeploymentUrl(output), null)
})
