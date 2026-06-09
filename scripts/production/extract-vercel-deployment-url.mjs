import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function cleanOutput(value) {
  return String(value ?? '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u0008/gu, '')
    .trim()
}

function normalizeDeploymentUrl(value) {
  const url = String(value ?? '').trim().replace(/^https?:\/\//iu, '').replace(/\/+$/u, '')
  if (!/^[a-z0-9][a-z0-9-]*(?:-[a-z0-9]+)*\.vercel\.app$/iu.test(url)
    && !/^[a-z0-9][a-z0-9-]*-[a-z0-9-]+\.vercel\.app$/iu.test(url)
    && !/^[a-z0-9][a-z0-9-]*-[a-z0-9-]+-[a-z0-9-]+\.vercel\.app$/iu.test(url)) {
    return null
  }
  return url
}

function candidatesFromJson(value) {
  if (!value || typeof value !== 'object') {
    return []
  }
  return [
    value.url,
    value.deploymentUrl,
    value.inspectorUrl,
    value?.deployment?.url,
    value?.deployment?.deploymentUrl,
  ].filter(Boolean)
}

export function extractVercelDeploymentUrl(output) {
  const cleaned = cleanOutput(output)
  if (!cleaned) {
    return null
  }

  try {
    const payload = JSON.parse(cleaned)
    for (const candidate of candidatesFromJson(payload)) {
      const normalized = normalizeDeploymentUrl(candidate)
      if (normalized) {
        return normalized
      }
    }
  } catch {
    // Fall through to text extraction.
  }

  const matches = [...cleaned.matchAll(/https?:\/\/([a-z0-9][a-z0-9-]*\.vercel\.app)(?:[/?#][^\s]*)?|(?<![@\w.-])([a-z0-9][a-z0-9-]*\.vercel\.app)(?![\w.-])/giu)]
  for (const match of matches.reverse()) {
    const normalized = normalizeDeploymentUrl(match[1] ?? match[2])
    if (normalized) {
      return normalized
    }
  }

  return null
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const inputPath = process.argv[2]
  const output = inputPath ? readFileSync(inputPath, 'utf8') : await readStdin()
  const deploymentUrl = extractVercelDeploymentUrl(output)
  if (!deploymentUrl) {
    console.error('[extract-vercel-deployment-url] no Vercel deployment URL found in deploy output')
    process.exitCode = 1
    return
  }
  console.log(deploymentUrl)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[extract-vercel-deployment-url] failed:', error)
    process.exitCode = 1
  })
}
