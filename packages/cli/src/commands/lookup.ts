import chalk from 'chalk'
import ora from 'ora'
import { BeamDirectory } from 'beam-protocol-sdk'
import type { BeamIdString } from 'beam-protocol-sdk'
import { loadConfig } from '../config.js'

interface LookupOptions {
  directory?: string
  json?: boolean
}

export async function cmdLookup(beamId: string, options: LookupOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl

  // Validate beam ID format
  if (!beamId.match(/^[a-z0-9_-]+@[a-z0-9_-]+\.beam\.directory$/)) {
    console.error(chalk.red(`✖ Invalid Beam ID format: ${beamId}`))
    console.error(chalk.dim('  Expected: agent@org.beam.directory'))
    process.exit(1)
  }

  const spinner = ora(`Looking up ${chalk.bold(beamId)}...`).start()

  try {
    const directory = new BeamDirectory({ baseUrl: directoryUrl })
    const record = await directory.lookup(beamId as BeamIdString)

    if (!record) {
      spinner.fail(`Agent not found: ${beamId}`)
      process.exit(1)
    }

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(record, null, 2))
      return
    }

    const trustBar = getTrustBar(record.trustScore)

    console.log('')
    console.log(chalk.bold(`🤖 ${record.displayName}`))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('Beam ID:')}      ${chalk.bold(record.beamId)}`)
    console.log(`${chalk.cyan('Org:')}          ${record.org}`)
    console.log(`${chalk.cyan('Trust Score:')} ${trustBar} ${(record.trustScore * 100).toFixed(0)}%`)
    console.log(`${chalk.cyan('Verified:')}     ${record.verified ? chalk.green('✓ Verified') : chalk.yellow('Unverified')}`)
    if (record.capabilities.length > 0) {
      console.log(`${chalk.cyan('Capabilities:')} ${record.capabilities.map(c => chalk.blue(c)).join(', ')}`)
    }
    console.log(`${chalk.cyan('Last Seen:')}   ${new Date(record.lastSeen).toLocaleString()}`)
    console.log(`${chalk.cyan('Registered:')}  ${new Date(record.createdAt).toLocaleString()}`)
    console.log('')
  } catch (err) {
    spinner.fail('Lookup failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}

function getTrustBar(score: number): string {
  const filled = Math.round(score * 10)
  const empty = 10 - filled
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  if (score >= 0.8) return chalk.green(bar)
  if (score >= 0.5) return chalk.yellow(bar)
  return chalk.red(bar)
}
