import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from '@beam-protocol/sdk'
import { loadConfig } from '../config.js'

interface VerifyDomainOptions {
  directory?: string
  json?: boolean
}

export async function cmdVerifyDomain(domain: string, options: VerifyDomainOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const spinner = ora(`Starting DNS verification for ${chalk.bold(domain)}...`).start()

  try {
    const client = new BeamClient({ identity: config.identity, directoryUrl })
    const verification = await client.verifyDomain(domain)
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(verification, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold('🌐 Domain verification started'))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('Domain:')}   ${verification.domain}`)
    console.log(`${chalk.cyan('Verified:')} ${verification.verified ? chalk.green('Yes') : chalk.yellow('Pending')}`)
    if (verification.txtName) console.log(`${chalk.cyan('TXT Name:')} ${verification.txtName}`)
    if (verification.txtValue ?? verification.expected) {
      console.log(`${chalk.cyan('TXT Value:')} ${verification.txtValue ?? verification.expected}`)
    }
    console.log('')
    console.log(chalk.dim('After adding the TXT record, run: beam verify check'))
  } catch (err) {
    spinner.fail('Domain verification failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
