import chalk from 'chalk'
import ora from 'ora'
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'
import { loadConfig } from '../config.js'

interface RegisterOptions {
  displayName?: string
  capabilities?: string
  directory?: string
}

export async function cmdRegister(options: RegisterOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl

  const parsed = BeamIdentity.parseBeamId(config.identity.beamId)
  if (!parsed) {
    console.error(chalk.red('✖ Invalid Beam ID in config'))
    process.exit(1)
  }

  const displayName = options.displayName ?? parsed.agent
  const capabilities = options.capabilities
    ? options.capabilities.split(',').map(c => c.trim()).filter(Boolean)
    : []

  const spinner = ora(`Registering ${chalk.bold(config.identity.beamId)}...`).start()

  try {
    const client = new BeamClient({
      identity: config.identity,
      directoryUrl
    })

    const record = await client.register(displayName, capabilities)

    spinner.succeed('Agent registered successfully')

    console.log('')
    console.log(chalk.bold('✅ Registration Complete'))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('Beam ID:')}      ${chalk.bold(record.beamId)}`)
    console.log(`${chalk.cyan('Display:')}      ${record.displayName}`)
    console.log(`${chalk.cyan('Org:')}          ${record.org ?? chalk.dim('consumer')}`)
    console.log(`${chalk.cyan('Trust Score:')} ${(record.trustScore * 100).toFixed(0)}%`)
    console.log(`${chalk.cyan('Verified:')}     ${record.verified ? chalk.green('Yes ✓') : chalk.yellow('No')}`)
    if (record.capabilities.length > 0) {
      console.log(`${chalk.cyan('Capabilities:')} ${record.capabilities.join(', ')}`)
    }
    console.log(`${chalk.cyan('Registered:')}  ${new Date(record.createdAt).toLocaleString()}`)
    console.log('')
    console.log(chalk.green('Next step:'), `beam lookup ${record.beamId}`)
  } catch (err) {
    spinner.fail('Registration failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
