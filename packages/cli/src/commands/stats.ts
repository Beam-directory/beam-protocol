import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from 'beam-protocol-sdk'
import { loadConfig } from '../config.js'

interface StatsOptions {
  directory?: string
  json?: boolean
}

export async function cmdStats(options: StatsOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const spinner = ora('Fetching directory statistics...').start()

  try {
    const client = new BeamClient({ identity: config.identity, directoryUrl })
    const stats = await client.getStats()
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(stats, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold('📈 Directory statistics'))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('Total agents:')} ${stats.totalAgents}`)
    console.log(`${chalk.cyan('Verified:')}     ${stats.verifiedAgents}`)
    console.log(`${chalk.cyan('Intents:')}      ${stats.intentsProcessed}`)
    if (stats.consumerAgents !== undefined) console.log(`${chalk.cyan('Consumers:')}    ${stats.consumerAgents}`)
    if (stats.version) console.log(`${chalk.cyan('Version:')}      ${stats.version}`)
    console.log('')
  } catch (err) {
    spinner.fail('Stats failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
