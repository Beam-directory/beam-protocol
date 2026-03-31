function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function requiredFlag(name) {
  const value = readFlag(name)
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing required flag: ${name}`)
  }
  return value.trim()
}

import { existsSync, readFileSync } from 'node:fs'

function loadEnvFile(path) {
  if (!path) {
    return
  }

  if (!existsSync(path)) {
    throw new Error(`Env file not found: ${path}`)
  }

  const text = readFileSync(path, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()
    value = value.replace(/^['"]|['"]$/g, '')

    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

function resolveGraphCredential(name, aliases = []) {
  for (const key of [name, ...aliases]) {
    const value = process.env[key]?.trim()
    if (value) {
      return value
    }
  }
  throw new Error(`Missing required Graph credential: ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}${text ? ` ${text}` : ''}`)
  }
  return {
    json: text ? JSON.parse(text) : null,
    headers: response.headers,
  }
}

async function acquireGraphToken() {
  const tenantId = resolveGraphCredential('MSGRAPH_TENANT_ID', ['GRAPH_TENANT_ID'])
  const clientId = resolveGraphCredential('MSGRAPH_CLIENT_ID', ['GRAPH_CLIENT_ID'])
  const clientSecret = resolveGraphCredential('MSGRAPH_CLIENT_SECRET', ['GRAPH_CLIENT_SECRET'])

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })

  const { json } = await fetchJson(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!json?.access_token) {
    throw new Error('Graph token response did not include access_token')
  }

  return json.access_token
}

async function fetchMailboxMessages({ token, mailbox, top = 10 }) {
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`)
  url.searchParams.set('$top', String(top))
  url.searchParams.set('$orderby', 'receivedDateTime DESC')
  url.searchParams.set('$select', 'subject,receivedDateTime,body')

  const { json } = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.body-content-type="html"',
    },
  })

  return Array.isArray(json?.value) ? json.value : []
}

function extractMagicLink(body) {
  if (!body) {
    return null
  }

  const match = body.match(/https:\/\/[^"'\\s<]+\/auth\/callback\?token=[A-Za-z0-9]+/i)
  return match ? match[0] : null
}

async function waitForMagicLink({ mailbox, subject, issuedAfter, attempts, delayMs }) {
  const token = await acquireGraphToken()
  const issuedAfterTs = Date.parse(issuedAfter)
  if (Number.isNaN(issuedAfterTs)) {
    throw new Error(`Invalid issuedAfter timestamp: ${issuedAfter}`)
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const messages = await fetchMailboxMessages({ token, mailbox, top: 10 })

    const match = messages.find((message) => {
      const receivedAt = Date.parse(message.receivedDateTime ?? '')
      if (!Number.isFinite(receivedAt) || receivedAt < issuedAfterTs) {
        return false
      }

      if ((message.subject ?? '').trim() !== subject) {
        return false
      }

      return Boolean(extractMagicLink(message.body?.content))
    })

    if (match) {
      const url = extractMagicLink(match.body?.content)
      if (!url) {
        throw new Error('Matching email found, but no magic link URL could be extracted')
      }

      return {
        receivedDateTime: match.receivedDateTime,
        subject: match.subject,
        url,
      }
    }

    if (attempt < attempts) {
      await sleep(delayMs)
    }
  }

  throw new Error(`No admin magic link email found in ${mailbox} after ${attempts} attempts`)
}

function readTokenFromMagicLink(url) {
  const parsed = new URL(url)
  const token = parsed.searchParams.get('token')
  if (!token) {
    throw new Error('Magic link URL did not include a token')
  }
  return token
}

async function main() {
  await loadEnvFile(readFlag('--env-file'))

  const apiUrl = requiredFlag('--api-url').replace(/\/+$/, '')
  const email = requiredFlag('--email').toLowerCase()
  const mailbox = (readFlag('--mailbox', email) ?? email).toLowerCase()
  const subject = readFlag('--subject', 'Beam admin sign-in link')
  const attempts = Number.parseInt(readFlag('--attempts', '12'), 10)
  const delayMs = Number.parseInt(readFlag('--delay-ms', '5000'), 10)
  const issuedAfter = new Date().toISOString()

  const { json: challenge } = await fetchJson(`${apiUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })

  if (!challenge?.ok) {
    throw new Error(`Magic link request did not return ok=true: ${JSON.stringify(challenge)}`)
  }

  const message = await waitForMagicLink({
    mailbox,
    subject,
    issuedAfter,
    attempts,
    delayMs,
  })

  const magicToken = readTokenFromMagicLink(message.url)
  const { json: verify, headers } = await fetchJson(`${apiUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: magicToken }),
  })

  const setCookie = headers.get('set-cookie')
  const sessionCookie = setCookie ? setCookie.split(';', 1)[0] : null
  const { json: session } = await fetchJson(`${apiUrl}/admin/auth/session`, {
    headers: sessionCookie ? { Cookie: sessionCookie } : undefined,
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        apiUrl,
        email,
        mailbox,
        challenge: {
          email: challenge.email,
          role: challenge.role,
          expiresAt: challenge.expiresAt,
        },
        magicLink: message,
        verify: {
          email: verify.email,
          role: verify.role,
          expiresAt: verify.expiresAt,
        },
        session,
        sessionCookie,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
