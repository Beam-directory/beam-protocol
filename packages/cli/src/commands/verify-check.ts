import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from '@beam-protocol/sdk'
import { loadConfig } from '../config.js'

interface VerifyCheckOptions {
  directory?: string
  json?: boolean
}

export async function cmdVerifyCheck(options: VerifyCheckOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const spinner = ora('Checking verification status...').start()

  try {
    const client = new BeamClient({ identity: config.identity, directoryUrl })
    const verification = await client.checkDomainVerification()
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(verification, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold('🔎 Verification status'))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('Domain:')}   ${verification.domain || chalk.dim('—')}`)
    console.log(`${chalk.cyan('Verified:')} ${verification.verified ? chalk.green('Yes ✓') : chalk.yellow('Pending')}`)
    console.log(`${chalk.cyan('Status:')}   ${verification.status ?? chalk.dim('—')}`)
    if (verification.tier) {
      console.log(`${chalk.cyan('Tier:')}     ${verification.tier}`)
    }
    console.log('')
  } catch (err) {
    spinner.fail('Verification check failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
