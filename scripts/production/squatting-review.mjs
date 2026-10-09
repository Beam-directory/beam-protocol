#!/usr/bin/env node

// Read-only review of agents whose name or org uses a known brand.
// It prints evidence and the exact suspension command. It never deletes.
// The only write path is an org suspension through the existing admin route,
// and it needs --apply, --confirm <beamId> and a note.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// A starting list of large German brands. Domains are the ones a real brand
// org would prove; review and extend before relying on it.
export const DEFAULT_BRANDS = [
  { brand: 'Lufthansa', aliases: ['lufthansa'], domains: ['lufthansa.com', 'lufthansagroup.com'] },
  { brand: 'Deutsche Bahn', aliases: ['deutschebahn', 'bahn', 'db'], domains: ['bahn.de', 'deutschebahn.com'] },
  { brand: 'Deutsche Telekom', aliases: ['telekom', 'deutschetelekom'], domains: ['telekom.de', 'telekom.com'] },
  { brand: 'Deutsche Post DHL', aliases: ['dhl', 'deutschepost'], domains: ['dhl.com', 'dhl.de', 'deutschepost.de'] },
  { brand: 'Deutsche Bank', aliases: ['deutschebank'], domains: ['db.com', 'deutsche-bank.de'] },
  { brand: 'Commerzbank', aliases: ['commerzbank'], domains: ['commerzbank.de', 'commerzbank.com'] },
  { brand: 'Sparkasse', aliases: ['sparkasse'], domains: ['sparkasse.de'] },
  { brand: 'Allianz', aliases: ['allianz'], domains: ['allianz.de', 'allianz.com'] },
  { brand: 'Siemens', aliases: ['siemens'], domains: ['siemens.com', 'siemens.de'] },
  { brand: 'SAP', aliases: ['sap'], domains: ['sap.com'] },
  { brand: 'Volkswagen', aliases: ['volkswagen', 'vw'], domains: ['volkswagen.de', 'volkswagen.com', 'volkswagen-group.com', 'vw.de'] },
  { brand: 'BMW', aliases: ['bmw'], domains: ['bmw.de', 'bmw.com', 'bmwgroup.com'] },
  { brand: 'Mercedes-Benz', aliases: ['mercedes', 'mercedesbenz', 'daimler'], domains: ['mercedes-benz.com', 'mercedes-benz.de', 'mercedes-benz-group.com'] },
  { brand: 'Porsche', aliases: ['porsche'], domains: ['porsche.com', 'porsche.de'] },
  { brand: 'Audi', aliases: ['audi'], domains: ['audi.de', 'audi.com'] },
  { brand: 'Bosch', aliases: ['bosch'], domains: ['bosch.com', 'bosch.de'] },
  { brand: 'BASF', aliases: ['basf'], domains: ['basf.com'] },
  { brand: 'Bayer', aliases: ['bayer'], domains: ['bayer.com', 'bayer.de'] },
  { brand: 'Adidas', aliases: ['adidas'], domains: ['adidas.de', 'adidas.com'] },
  { brand: 'Infineon', aliases: ['infineon'], domains: ['infineon.com'] },
  { brand: 'Henkel', aliases: ['henkel'], domains: ['henkel.com', 'henkel.de'] },
  { brand: 'E.ON', aliases: ['eon'], domains: ['eon.com', 'eon.de'] },
  { brand: 'TUI', aliases: ['tui'], domains: ['tui.com', 'tui.de'] },
  { brand: 'Lidl', aliases: ['lidl'], domains: ['lidl.de', 'lidl.com'] },
  { brand: 'Aldi', aliases: ['aldi'], domains: ['aldi-nord.de', 'aldi-sued.de'] },
  { brand: 'REWE', aliases: ['rewe'], domains: ['rewe.de', 'rewe-group.com'] },
  { brand: 'Edeka', aliases: ['edeka'], domains: ['edeka.de'] },
  { brand: 'Zalando', aliases: ['zalando'], domains: ['zalando.de', 'zalando.com'] },
  { brand: 'Check24', aliases: ['check24'], domains: ['check24.de'] },
]

// Short aliases such as "db" or "vw" only match a whole token. Longer aliases
// also match inside a compound such as "lufthansabooking".
const SUBSTRING_MIN = 5

function tokens(value) {
  return String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function aliasMatches(alias, value) {
  if (tokens(value).includes(alias)) return true
  if (alias.length < SUBSTRING_MIN) return false
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(alias)
}

function parseBeamId(beamId) {
  const match = /^([a-z0-9_-]+)@(?:([a-z0-9_-]+)\.)?beam\.directory$/.exec(beamId)
  return match ? { local: match[1], namespace: match[2] ?? null } : { local: beamId, namespace: null }
}

export function matchBrands(agent, brands = DEFAULT_BRANDS) {
  const { local, namespace } = parseBeamId(agent.beam_id)
  const fields = { namespace: namespace ?? '', agentName: local, displayName: agent.display_name }
  const hits = []
  for (const brand of brands) {
    for (const [field, value] of Object.entries(fields)) {
      const alias = brand.aliases.find((candidate) => aliasMatches(candidate, value))
      if (alias) hits.push({ brand: brand.brand, alias, field, domains: brand.domains })
    }
  }
  return hits
}

function domainIsBrand(domain, brandDomains) {
  const value = String(domain ?? '').toLowerCase()
  return brandDomains.some((candidate) => value === candidate || value.endsWith(`.${candidate}`))
}

function assess(agent, org, hits) {
  const namespace = parseBeamId(agent.beam_id).namespace
  const brandDomains = hits.flatMap((hit) => hit.domains)
  const namespaceHit = hits.some((hit) => hit.field === 'namespace')
  if (!namespace) {
    return { finding: 'personal-namespace', risk: 'medium', reason: 'Personal Beam ID that uses a brand name. No org or domain proof.' }
  }
  if (!org) {
    return { finding: 'no-org-record', risk: namespaceHit ? 'high' : 'medium', reason: `No org record exists for namespace ${namespace}. The agent predates org registration or the org was removed. No domain proof.` }
  }
  if (org.verified !== 1) {
    return { finding: 'org-unverified', risk: namespaceHit ? 'high' : 'medium', reason: `Org ${org.name} is not verified. No domain proof.` }
  }
  if (domainIsBrand(org.domain, brandDomains)) {
    return { finding: 'org-domain-matches-brand', risk: 'none', reason: `Org ${org.name} proved ${org.domain} via ${org.domain_verified_via ?? 'unknown method'}, a known brand domain.` }
  }
  return { finding: 'org-domain-not-brand', risk: namespaceHit ? 'high' : 'medium', reason: `Org ${org.name} proved ${org.domain ?? 'no domain'}, which is not a known brand domain.` }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function suggest(agent, org, assessment, orgAgents, directoryUrl) {
  const base = directoryUrl ? directoryUrl.replace(/\/+$/, '') : '$BEAM_DIRECTORY_URL'
  const deleteInfo = `Not offered: deleting the agent (DELETE /agents/${encodeURIComponent(agent.beam_id)} with an admin session). The owner has not decided between suspension and deletion. This script cannot delete.`
  if (assessment.risk === 'none') {
    return { kind: 'none', command: null, scriptCommand: null, affectedAgents: [], note: 'Domain proof matches the brand. No action suggested.', deleteInfo }
  }
  if (agent.suspended_at) {
    return { kind: 'already-suspended', command: null, scriptCommand: null, affectedAgents: [], note: `Agent already suspended at ${agent.suspended_at}.`, deleteInfo }
  }
  if (org && parseBeamId(agent.beam_id).namespace === org.name) {
    const note = `Brand squatting review: ${agent.beam_id}`
    return {
      kind: 'suspend-org',
      command: `curl -sS -X POST ${shellQuote(`${base}/admin/orgs/${encodeURIComponent(org.name)}/suspension`)} -H "Authorization: Bearer $BEAM_ADMIN_TOKEN" -H 'content-type: application/json' -d ${shellQuote(JSON.stringify({ note }))}`,
      scriptCommand: [
        'BEAM_ADMIN_TOKEN=... node scripts/production/squatting-review.mjs --db <directory.sqlite>',
        `--directory-url ${shellQuote(base)} --apply --confirm ${agent.beam_id}`,
        orgAgents.length > 1 ? `--confirm-org ${org.name}` : null,
        `--note ${shellQuote(note)}`,
      ].filter(Boolean).join(' '),
      affectedAgents: orgAgents,
      note: `Suspends org ${org.name}. Every agent in it is treated as suspended (${orgAgents.length} agent${orgAgents.length === 1 ? '' : 's'}). Undo: POST /admin/orgs/${org.name}/unsuspend with a note.`,
      deleteInfo,
    }
  }
  return {
    kind: 'manual',
    command: null,
    scriptCommand: null,
    affectedAgents: [agent.beam_id],
    note: 'No admin route suspends a single agent outside an abuse review, and there is no org record to suspend. Existing path: an abuse report against this agent, then POST /admin/abuse/:id/review with decision block_agent. That needs a report tied to a real message or intent.',
    deleteInfo,
  }
}

export function reviewDatabase(db, { brands = DEFAULT_BRANDS, directoryUrl = null } = {}) {
  const agents = db.prepare(`
    SELECT beam_id, display_name, org, personal, created_at, verification_tier, email_verified, suspended_at, visibility
    FROM agents
    ORDER BY beam_id
  `).all()
  const orgs = new Map(db.prepare(`
    SELECT name, display_name, domain, verified, verified_at, domain_verified_via, created_at, requested_name, suspended_at
    FROM orgs
  `).all().map((row) => [row.name, row]))
  const agentsByOrg = new Map()
  for (const agent of agents) {
    const namespace = parseBeamId(agent.beam_id).namespace
    if (!namespace) continue
    agentsByOrg.set(namespace, [...(agentsByOrg.get(namespace) ?? []), agent.beam_id])
  }

  const candidates = []
  for (const agent of agents) {
    const hits = matchBrands(agent, brands)
    if (hits.length === 0) continue
    const namespace = parseBeamId(agent.beam_id).namespace
    const org = namespace ? orgs.get(namespace) ?? null : null
    const assessment = assess(agent, org, hits)
    candidates.push({
      beamId: agent.beam_id,
      displayName: agent.display_name,
      brands: [...new Set(hits.map((hit) => hit.brand))],
      matchedOn: hits.map((hit) => `${hit.field}~${hit.alias}`),
      evidence: {
        agentCreatedAt: agent.created_at,
        agentVerificationTier: agent.verification_tier,
        agentEmailVerified: agent.email_verified === 1,
        agentVisibility: agent.visibility,
        agentSuspendedAt: agent.suspended_at,
        namespace,
        org: org ? {
          name: org.name,
          displayName: org.display_name,
          createdAt: org.created_at,
          verified: org.verified === 1,
          verifiedAt: org.verified_at,
          domain: org.domain,
          domainVerifiedVia: org.domain_verified_via,
          suspendedAt: org.suspended_at,
        } : null,
        knownBrandDomains: [...new Set(hits.flatMap((hit) => hit.domains))],
      },
      assessment,
      action: suggest(agent, org, assessment, namespace ? agentsByOrg.get(namespace) ?? [] : [], directoryUrl),
    })
  }

  const matchingOrgs = [...orgs.values()]
    .filter((org) => brands.some((brand) => brand.aliases.some((alias) => [org.name, org.requested_name, org.display_name].some((value) => aliasMatches(alias, value)))))
    .map((org) => ({ name: org.name, requestedName: org.requested_name, domain: org.domain, verified: org.verified === 1, createdAt: org.created_at, suspendedAt: org.suspended_at }))

  return { generatedAt: new Date().toISOString(), scannedAgents: agents.length, candidates, matchingOrgs }
}

export function renderMarkdown(review, { focus = [] } = {}) {
  const lines = ['# Brand squatting review', '']
  lines.push(`Read-only. Scanned ${review.scannedAgents} agents. ${review.candidates.length} match a brand. Nothing was changed.`, '')
  const ordered = [...review.candidates].sort((left, right) => Number(focus.includes(right.beamId)) - Number(focus.includes(left.beamId)))
  for (const candidate of ordered) {
    const e = candidate.evidence
    lines.push(`## ${candidate.beamId}${focus.includes(candidate.beamId) ? ' (focus)' : ''}`, '')
    lines.push(`- Brand: ${candidate.brands.join(', ')} (matched on ${candidate.matchedOn.join(', ')})`)
    lines.push(`- Risk: ${candidate.assessment.risk} (${candidate.assessment.finding})`)
    lines.push(`- Why: ${candidate.assessment.reason}`)
    lines.push(`- Agent created: ${e.agentCreatedAt}; tier ${e.agentVerificationTier}; email verified ${e.agentEmailVerified ? 'yes' : 'no'}; ${e.agentVisibility}; suspended ${e.agentSuspendedAt ?? 'no'}`)
    lines.push(e.org
      ? `- Org: ${e.org.name}, created ${e.org.createdAt}, verified ${e.org.verified ? `yes (${e.org.verifiedAt}, ${e.org.domainVerifiedVia ?? 'method unknown'})` : 'no'}, domain ${e.org.domain ?? 'none'}, suspended ${e.org.suspendedAt ?? 'no'}`
      : `- Org: ${e.namespace ? `no org record for namespace ${e.namespace}` : 'personal namespace'}`)
    lines.push(`- Brand domains we would expect: ${e.knownBrandDomains.join(', ')}`)
    lines.push(`- Suggested action: ${candidate.action.kind}. ${candidate.action.note}`)
    if (candidate.action.affectedAgents.length > 0 && candidate.action.kind === 'suspend-org') {
      lines.push(`- Affected agents: ${candidate.action.affectedAgents.join(', ')}`)
    }
    if (candidate.action.command) {
      lines.push('- Command that WOULD suspend (not run):', '', '```sh', candidate.action.command, '```', '')
      lines.push('- Same step through this script (not run):', '', '```sh', candidate.action.scriptCommand, '```', '')
    }
    lines.push(`- ${candidate.action.deleteInfo}`, '')
  }
  if (review.matchingOrgs.length > 0) {
    lines.push('## Org records that use a brand name', '')
    for (const org of review.matchingOrgs) {
      lines.push(`- ${org.name} (requested ${org.requestedName ?? '-'}), domain ${org.domain ?? 'none'}, verified ${org.verified ? 'yes' : 'no'}, created ${org.createdAt}, suspended ${org.suspendedAt ?? 'no'}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export async function applySuspension(review, { confirm, confirmOrg = null, note, directoryUrl, adminToken, fetchImpl = fetch }) {
  const candidate = review.candidates.find((entry) => entry.beamId === confirm)
  if (!candidate) throw new Error(`--confirm ${confirm ?? '(missing)'} is not a candidate in this review`)
  if (candidate.action.kind !== 'suspend-org') {
    throw new Error(`${confirm} has no suspension this script can run (${candidate.action.kind}). ${candidate.action.note}`)
  }
  const orgName = candidate.evidence.org.name
  if (candidate.action.affectedAgents.length > 1 && confirmOrg !== orgName) {
    throw new Error(`Suspending ${orgName} affects ${candidate.action.affectedAgents.length} agents. Add --confirm-org ${orgName}.`)
  }
  if (!note || note.trim().length < 3) throw new Error('--note is required and must explain the suspension')
  if (!directoryUrl) throw new Error('--directory-url is required with --apply')
  if (!adminToken) throw new Error('BEAM_ADMIN_TOKEN is required with --apply')
  const response = await fetchImpl(`${directoryUrl.replace(/\/+$/, '')}/admin/orgs/${encodeURIComponent(orgName)}/suspension`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ note: note.trim() }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`suspension answered ${response.status}${body?.errorCode ? ` ${body.errorCode}` : ''}`)
  return { org: orgName, suspendedAt: body?.suspendedAt ?? null }
}

function flag(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return null
  const value = argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

export async function openReadOnly(dbPath) {
  const { default: Database } = await import('better-sqlite3')
  return new Database(dbPath, { readonly: true, fileMustExist: true })
}

export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, stdout = process.stdout, env = process.env } = {}) {
  const dbPath = flag(argv, '--db')
  if (!dbPath) throw new Error('--db <directory.sqlite> is required (opened read-only)')
  const brandsPath = flag(argv, '--brands')
  const brands = brandsPath ? JSON.parse(readFileSync(brandsPath, 'utf8')) : DEFAULT_BRANDS
  const directoryUrl = flag(argv, '--directory-url')
  const focus = [flag(argv, '--focus'), flag(argv, '--confirm')].filter(Boolean)
  const apply = argv.includes('--apply')
  const confirm = flag(argv, '--confirm')

  if (apply && !confirm) throw new Error('--apply needs --confirm <beamId>')

  const db = await openReadOnly(dbPath)
  let review
  try {
    review = reviewDatabase(db, { brands, directoryUrl })
  } finally {
    db.close()
  }

  const markdown = renderMarkdown(review, { focus })
  stdout.write(`${markdown}\n`)
  const reportPath = flag(argv, '--report')
  if (reportPath) writeFileSync(reportPath, `${markdown}\n`)
  const jsonPath = flag(argv, '--json')
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`)

  if (!apply) {
    stdout.write('\nDry run. No request was sent. To suspend, re-run with --apply --confirm <beamId> --note "...".\n')
    return 0
  }
  const result = await applySuspension(review, {
    confirm,
    confirmOrg: flag(argv, '--confirm-org'),
    note: flag(argv, '--note'),
    directoryUrl,
    adminToken: env.BEAM_ADMIN_TOKEN,
    fetchImpl,
  })
  stdout.write(`\nSuspended org ${result.org} at ${result.suspendedAt}.\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code },
    (error) => {
      console.error(`[squatting-review] ${error.message}`)
      process.exitCode = 1
    },
  )
}
