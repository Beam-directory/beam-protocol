import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from '@beam-protocol/sdk'
import { BEAM_ID_PATTERN, loadConfig } from '../config.js'

interface ReportOptions {
  reason?: string
  directory?: string
  json?: boolean
}

export async function cmdReport(targetBeamId: string, options: ReportOptions): Promise<void> {
  if (!BEAM_ID_PATTERN.test(targetBeamId)) {
    console.error(chalk.red(`✖ Invalid Beam ID: ${targetBeamId}`))
    process.exit(1)
  }
  if (!options.reason) {
    console.error(chalk.red('✖ Missing required --reason value'))
    process.exit(1)
  }

  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const spinner = ora(`Submitting report for ${chalk.bold(targetBeamId)}...`).start()

  try {
    const client = new BeamClient({ identity: config.identity, directoryUrl })
    const report = await client.report(targetBeamId, options.reason)
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold.yellow('⚠ Agent reported'))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('Reporter:')} ${report.reporterBeamId}`)
    console.log(`${chalk.cyan('Target:')}   ${report.targetBeamId}`)
    console.log(`${chalk.cyan('Reason:')}   ${report.reason}`)
    if (report.status) console.log(`${chalk.cyan('Status:')}   ${report.status}`)
    console.log('')
  } catch (err) {
    spinner.fail('Report failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
