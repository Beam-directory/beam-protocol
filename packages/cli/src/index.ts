#!/usr/bin/env node
import { Command } from 'commander'
import chalk from 'chalk'
import { cmdInit } from './commands/init.js'
import { cmdRegister } from './commands/register.js'
import { cmdLookup } from './commands/lookup.js'
import { cmdSearch } from './commands/search.js'
import { cmdSend } from './commands/send.js'

const program = new Command()

program
  .name('beam')
  .description(
    chalk.bold('Beam Protocol CLI') + '\n' +
    chalk.dim('SMTP for AI Agents — agent identity, registration & intent routing')
  )
  .version('0.1.0')

// ─── beam init ────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Generate a new Beam identity (writes .beam/identity.json)')
  .requiredOption('-a, --agent <name>', 'Agent name (e.g. jarvis)')
  .requiredOption('-o, --org <name>', 'Organisation name (e.g. coppen)')
  .option('-d, --directory <url>', 'Directory server URL', process.env['BEAM_DIRECTORY_URL'] ?? 'https://api.beam.directory')
  .option('-f, --force', 'Overwrite existing identity')
  .action(async (opts: { agent: string; org: string; directory?: string; force?: boolean }) => {
    await cmdInit(opts)
  })

// ─── beam register ────────────────────────────────────────────────────────────
program
  .command('register')
  .description('Register this agent with a Beam directory')
  .option('-n, --display-name <name>', 'Human-readable display name')
  .option('-c, --capabilities <list>', 'Comma-separated capabilities (e.g. query,answer,write)')
  .option('-d, --directory <url>', 'Override directory URL')
  .action(async (opts: { displayName?: string; capabilities?: string; directory?: string }) => {
    await cmdRegister(opts)
  })

// ─── beam lookup ──────────────────────────────────────────────────────────────
program
  .command('lookup <beamId>')
  .description('Look up an agent by Beam ID')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('--json', 'Output raw JSON')
  .action(async (beamId: string, opts: { directory?: string; json?: boolean }) => {
    await cmdLookup(beamId, opts)
  })

// ─── beam search ──────────────────────────────────────────────────────────────
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

// ─── beam send ────────────────────────────────────────────────────────────────
program
  .command('send <to> <intent> [params]')
  .description('Send an intent to an agent and print the result')
  .option('-d, --directory <url>', 'Override directory URL')
  .option('-t, --timeout <seconds>', 'Timeout in seconds', '10')
  .option('--json', 'Output raw JSON')
  .action(async (to: string, intent: string, params: string | undefined, opts: { directory?: string; timeout?: string; json?: boolean }) => {
    await cmdSend(to, intent, params, opts)
  })

// ─── Error handling ───────────────────────────────────────────────────────────
program.configureOutput({
  writeErr: str => process.stderr.write(chalk.red(str))
})

program.parse()
