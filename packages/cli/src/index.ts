#!/usr/bin/env node
import { createRequire } from 'node:module'
import { Command } from 'commander'
import chalk from 'chalk'
import { cmdInit } from './commands/init.js'
import { cmdRegister } from './commands/register.js'
import { cmdLookup } from './commands/lookup.js'
import { cmdSearch } from './commands/search.js'
import { cmdSend } from './commands/send.js'
import { cmdBrowse } from './commands/browse.js'
import { cmdProfileUpdate } from './commands/profile-update.js'
import { cmdVerifyDomain } from './commands/verify-domain.js'
import { cmdVerifyCheck } from './commands/verify-check.js'
import { cmdStats } from './commands/stats.js'
import { cmdDelegate } from './commands/delegate.js'
import { cmdReport } from './commands/report.js'
import { cmdTalk } from './commands/talk.js'
import { cmdKeysList } from './commands/keys-list.js'
import { cmdKeysRotate } from './commands/keys-rotate.js'
import { cmdKeysRevoke } from './commands/keys-revoke.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }
const program = new Command()

program
  .name('beam')
  .description(
    chalk.bold('Beam Protocol CLI') + '\n' +
    chalk.dim('SMTP for AI Agents — agent identity, registration & intent routing')
  )
  .version(version)

program
  .command('init')
  .description('Generate a new Beam identity (writes .beam/identity.json)')
  .option('-a, --agent <name>', 'Agent name (e.g. jarvis)')
  .option('-n, --name <name>', 'Alias for --agent')
  .option('-o, --org <name>', 'Organisation name (optional for consumer Beam-IDs)')
  .option('-d, --directory <url>', 'Directory server URL', process.env['BEAM_DIRECTORY_URL'] ?? 'https://api.beam.directory')
  .option('-f, --force', 'Overwrite existing identity')
  .action(async (opts: { agent?: string; name?: string; org?: string; directory?: string; force?: boolean }) => {
    const agent = opts.agent ?? opts.name
    if (!agent) {
      throw new Error('init requires --agent <name>')
    }

    await cmdInit({ agent, org: opts.org, directory: opts.directory, force: opts.force })
  })

program
  .command('register')
  .description('Register this agent with a Beam directory')
  .option('-n, --display-name <name>', 'Human-readable display name')
  .option('--name <name>', 'Alias for --display-name')
  .option('-c, --capabilities <list>', 'Comma-separated capabilities (e.g. query,answer,write)')
  .option('-d, --directory <url>', 'Override directory URL')
  .action(async (opts: { displayName?: string; name?: string; capabilities?: string; directory?: string }) => {
    await cmdRegister({
      displayName: opts.displayName ?? opts.name,
      capabilities: opts.capabilities,
      directory: opts.directory,
    })
  })

program
  .command('lookup <beamId>')
  .description('Look up an agent by Beam ID')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (beamId: string, opts: { directory?: string; json?: boolean }) => {
    await cmdLookup(beamId, opts)
  })

program
  .command('search')
  .description('Search for agents in the directory')
  .option('--org <org>', 'Filter by organisation')
  .option('--capability <cap>', 'Filter by capability')
  .option('--min-trust <score>', 'Minimum trust score (0.0-1.0)')
  .option('--limit <n>', 'Max results', '20')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { org?: string; capability?: string; minTrust?: string; limit?: string; directory?: string; json?: boolean }) => {
    await cmdSearch(opts)
  })

program
  .command('browse')
  .description('Browse paginated agent listings')
  .option('--page <n>', 'Page number', '1')
  .option('--capability <cap>', 'Filter by capability')
  .option('--tier <tier>', 'Filter by verification tier')
  .option('--verified-only', 'Only show verified agents')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { page?: string; capability?: string; tier?: string; verifiedOnly?: boolean; directory?: string; json?: boolean }) => {
    await cmdBrowse(opts)
  })

const profile = program.command('profile').description('Profile management commands')
profile
  .command('update')
  .description('Update your agent profile')
  .option('--description <text>', 'Profile description')
  .option('--logo-url <url>', 'Public logo URL')
  .option('--website <url>', 'Public website URL')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { description?: string; logoUrl?: string; website?: string; directory?: string; json?: boolean }) => {
    await cmdProfileUpdate(opts)
  })

const verify = program.command('verify').description('Verification commands')
verify
  .command('domain <domain>')
  .description('Initiate DNS verification for a domain')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (domain: string, opts: { directory?: string; json?: boolean }) => {
    await cmdVerifyDomain(domain, opts)
  })

verify
  .command('check')
  .description('Check current verification status')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { directory?: string; json?: boolean }) => {
    await cmdVerifyCheck(opts)
  })

program
  .command('stats')
  .description('Show directory statistics')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { directory?: string; json?: boolean }) => {
    await cmdStats(opts)
  })

program
  .command('delegate <targetBeamId>')
  .description('Create a delegation for another Beam agent')
  .requiredOption('--scope <scope>', 'Delegation scope')
  .option('--expires <hours>', 'Hours until delegation expiry')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (targetBeamId: string, opts: { scope?: string; expires?: string; directory?: string; json?: boolean }) => {
    await cmdDelegate(targetBeamId, opts)
  })

program
  .command('report <targetBeamId>')
  .description('Report an agent')
  .requiredOption('--reason <reason>', 'Reason for the report')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (targetBeamId: string, opts: { reason?: string; directory?: string; json?: boolean }) => {
    await cmdReport(targetBeamId, opts)
  })

program
  .command('send <to> <intent> [params]')
  .description('Send an intent to an agent and print the result')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('-t, --timeout <seconds>', 'Timeout in seconds', '10')
  .option('--json', 'Output raw JSON')
  .action(async (to: string, intent: string, params: string | undefined, opts: { directory?: string; timeout?: string; json?: boolean }) => {
    await cmdSend(to, intent, params, opts)
  })

program
  .command('talk <to> <message>')
  .description('Send a natural-language message via conversation.message')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('-t, --timeout <seconds>', 'Timeout in seconds', '60')
  .option('-l, --language <language>', 'Language hint, e.g. en or de')
  .option('-c, --context <json>', 'Optional context JSON object')
  .option('--json', 'Output raw JSON')
  .action(async (to: string, message: string, opts: { directory?: string; timeout?: string; language?: string; context?: string; json?: boolean }) => {
    await cmdTalk(to, message, opts)
  })

const keys = program.command('keys').description('Signing key lifecycle commands')
keys
  .command('list [beamId]')
  .description('List active and revoked signing keys for an agent')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (beamId: string | undefined, opts: { directory?: string; json?: boolean }) => {
    await cmdKeysList(beamId, opts)
  })

keys
  .command('rotate')
  .description('Rotate the local agent signing key and update .beam/identity.json')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { directory?: string; json?: boolean }) => {
    await cmdKeysRotate(opts)
  })

keys
  .command('revoke <publicKey>')
  .description('Revoke a previously rotated-out signing key')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (publicKey: string, opts: { directory?: string; json?: boolean }) => {
    await cmdKeysRevoke(publicKey, opts)
  })

program.configureOutput({
  outputError: (str, write) => write(chalk.red(str))
})

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(chalk.red(`\n✖ ${err.message}`))
  process.exit(1)
})
