import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from 'beam-protocol-sdk'
import { loadConfig, resolveDirectoryUrl } from '../config.js'

interface KeysRevokeOptions {
  directory?: string
  json?: boolean
}

export async function cmdKeysRevoke(publicKey: string, options: KeysRevokeOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = resolveDirectoryUrl(options.directory)
  const trimmedKey = publicKey.trim()
  if (!trimmedKey) {
    throw new Error('publicKey is required')
  }

  const spinner = ora(`Revoking key for ${chalk.bold(config.identity.beamId)}...`).start()

  try {
    const client = new BeamClient({
      identity: config.identity,
      directoryUrl,
    })
    const result = await client.revokeKey(trimmedKey)
    spinner.succeed('Key revoked')

    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold('🧾 Key Revoked'))
    console.log(chalk.dim('─'.repeat(60)))
    console.log(`${chalk.cyan('Beam ID:')}     ${config.identity.beamId}`)
    console.log(`${chalk.cyan('Revoked key:')} ${result.revokedKey?.publicKey ?? trimmedKey}`)
    console.log(`${chalk.cyan('Active key:')}  ${result.keyState.active?.publicKey ?? chalk.dim('none')}`)
  } catch (error) {
    spinner.fail('Key revocation failed')
    throw error
  }
}
