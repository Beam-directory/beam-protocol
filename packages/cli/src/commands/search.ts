import chalk from 'chalk'
import ora from 'ora'
import { BeamDirectory } from '@beam-protocol/sdk'
import { loadConfig } from '../config.js'

interface SearchOptions {
  org?: string
  capability?: string
  minTrust?: string
  limit?: string
  directory?: string
  json?: boolean
}

export async function cmdSearch(options: SearchOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl

  const query = {
    org: options.org,
    capabilities: options.capability ? [options.capability] : undefined,
    minTrustScore: options.minTrust ? parseFloat(options.minTrust) : undefined,
    limit: options.limit ? parseInt(options.limit, 10) : 20
  }

  const parts = []
  if (query.org) parts.push(`org=${query.org}`)
  if (query.capabilities) parts.push(`capability=${query.capabilities[0]}`)
  const label = parts.length ? parts.join(', ') : 'all agents'

  const spinner = ora(`Searching ${label}...`).start()

  try {
    const directory = new BeamDirectory({ baseUrl: directoryUrl })
    const agents = await directory.search(query)

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(agents, null, 2))
      return
    }

    if (agents.length === 0) {
      console.log(chalk.yellow(`\n  No agents found matching your query.\n`))
      return
    }

    console.log('')
    console.log(chalk.bold(`🔍 Found ${agents.length} agent${agents.length !== 1 ? 's' : ''}`))
    console.log(chalk.dim('─'.repeat(60)))

    for (const agent of agents) {
      const trustPct = (agent.trustScore * 100).toFixed(0)
      const verified = agent.verified ? chalk.green('✓') : chalk.dim('○')
      const caps = agent.capabilities.length > 0
        ? chalk.dim(` [${agent.capabilities.join(', ')}]`)
        : ''

      console.log(
        `  ${verified} ${chalk.bold(agent.beamId)}${caps}`
      )
      console.log(
        `     ${chalk.dim(agent.displayName)} · Trust: ${getTrustColored(agent.trustScore, trustPct + '%')} · Last seen: ${formatRelative(agent.lastSeen)}`
      )
      console.log('')
    }
  } catch (err) {
    spinner.fail('Search failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}

function getTrustColored(score: number, label: string): string {
  if (score >= 0.8) return chalk.green(label)
  if (score >= 0.5) return chalk.yellow(label)
  return chalk.red(label)
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return chalk.dim('just now')
  if (minutes < 60) return chalk.dim(`${minutes}m ago`)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return chalk.dim(`${hours}h ago`)
  const days = Math.floor(hours / 24)
  return chalk.dim(`${days}d ago`)
}
