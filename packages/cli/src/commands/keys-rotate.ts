import chalk from 'chalk'
import ora from 'ora'
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'
import { loadConfig, resolveDirectoryUrl, saveConfig } from '../config.js'

interface KeysRotateOptions {
  directory?: string
  json?: boolean
}

export async function cmdKeysRotate(options: KeysRotateOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = resolveDirectoryUrl(options.directory)
  const parsed = BeamIdentity.parseBeamId(config.identity.beamId)
  if (!parsed) {
    throw new Error('Invalid Beam ID in local config')
  }

  const replacementIdentity = BeamIdentity.generate({
    agentName: parsed.agent,
    ...(parsed.org ? { orgName: parsed.org } : {}),
  })

  const spinner = ora(`Rotating signing key for ${chalk.bold(config.identity.beamId)}...`).start()

  try {
    const client = new BeamClient({
      identity: config.identity,
      directoryUrl,
    })
    const result = await client.rotateKeys(replacementIdentity.export())

    saveConfig({
      ...config,
      identity: replacementIdentity.export(),
      directoryUrl,
    })

    spinner.succeed('Key rotated')

    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold('🔐 Key Rotation Complete'))
    console.log(chalk.dim('─'.repeat(60)))
    console.log(`${chalk.cyan('Beam ID:')}        ${config.identity.beamId}`)
    console.log(`${chalk.cyan('New active key:')} ${replacementIdentity.publicKeyBase64}`)
    if (result.previousKey) {
      console.log(`${chalk.cyan('Revoked key:')}    ${result.previousKey}`)
    }
    console.log(chalk.dim('The local .beam/identity.json has been updated to the new keypair.'))
  } catch (error) {
    spinner.fail('Key rotation failed')
    throw error
  }
}
