import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from '@beam-protocol/sdk'
import type { BrowseFilters } from '@beam-protocol/sdk'
import { loadConfig } from '../config.js'

interface BrowseOptions {
  page?: string
  capability?: string
  tier?: string
  verifiedOnly?: boolean
  directory?: string
  json?: boolean
}

export async function cmdBrowse(options: BrowseOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const page = options.page ? parseInt(options.page, 10) : 1
  const filters: BrowseFilters = {
    capability: options.capability,
    tier: options.tier as BrowseFilters['tier'],
    verified_only: options.verifiedOnly,
  }

  const spinner = ora(`Browsing directory page ${page}...`).start()

  try {
    const client = new BeamClient({ identity: config.identity, directoryUrl })
    const result = await client.browse(page, filters)
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold(`📚 Directory Page ${result.page}`))
    console.log(chalk.dim(`Showing ${result.agents.length} of ${result.total} agents`))
    console.log(chalk.dim('─'.repeat(72)))

    for (const agent of result.agents) {
      const badge = agent.verified ? chalk.green('✓') : chalk.dim('○')
      const tier = agent.verificationTier ? chalk.magenta(agent.verificationTier) : chalk.dim('basic')
      console.log(`  ${badge} ${chalk.bold(agent.beamId)} ${chalk.dim(`(${tier})`)}`)
      console.log(`     ${agent.displayName}${agent.description ? chalk.dim(` — ${agent.description}`) : ''}`)
      if (agent.capabilities.length > 0) {
        console.log(`     ${chalk.cyan('Capabilities:')} ${agent.capabilities.join(', ')}`)
      }
      if (agent.website) {
        console.log(`     ${chalk.cyan('Website:')} ${agent.website}`)
      }
      console.log('')
    }
  } catch (err) {
    spinner.fail('Browse failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
