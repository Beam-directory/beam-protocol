import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from 'beam-protocol-sdk'
import { BEAM_ID_PATTERN, loadConfig } from '../config.js'

interface DelegateOptions {
  scope?: string
  expires?: string
  directory?: string
  json?: boolean
}

export async function cmdDelegate(targetBeamId: string, options: DelegateOptions): Promise<void> {
  if (!BEAM_ID_PATTERN.test(targetBeamId)) {
    console.error(chalk.red(`✖ Invalid Beam ID: ${targetBeamId}`))
    process.exit(1)
  }
  if (!options.scope) {
    console.error(chalk.red('✖ Missing required --scope value'))
    process.exit(1)
  }

  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const expiresIn = options.expires ? parseInt(options.expires, 10) : undefined
  const spinner = ora(`Creating delegation for ${chalk.bold(targetBeamId)}...`).start()

  try {
    const client = new BeamClient({ identity: config.identity, directoryUrl })
    const delegation = await client.delegate(targetBeamId, options.scope, expiresIn)
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(delegation, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold.green('✅ Delegation created'))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('From:')}      ${delegation.sourceBeamId}`)
    console.log(`${chalk.cyan('To:')}        ${delegation.targetBeamId}`)
    console.log(`${chalk.cyan('Scope:')}     ${delegation.scope}`)
    if (delegation.expiresAt) console.log(`${chalk.cyan('Expires:')}   ${delegation.expiresAt}`)
    if (delegation.status) console.log(`${chalk.cyan('Status:')}    ${delegation.status}`)
    console.log('')
  } catch (err) {
    spinner.fail('Delegation failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
