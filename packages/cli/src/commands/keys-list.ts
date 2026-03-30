import chalk from 'chalk'
import { BeamDirectory } from 'beam-protocol-sdk'
import type { BeamIdString } from 'beam-protocol-sdk'
import { loadOptionalConfig, resolveDirectoryUrl } from '../config.js'

interface KeysListOptions {
  directory?: string
  json?: boolean
}

export async function cmdKeysList(beamId: string | undefined, options: KeysListOptions): Promise<void> {
  const config = loadOptionalConfig()
  const resolvedBeamId = beamId ?? config?.identity.beamId
  if (!resolvedBeamId) {
    throw new Error('keys list requires <beamId> or a local .beam/identity.json')
  }

  const directory = new BeamDirectory({
    baseUrl: resolveDirectoryUrl(options.directory),
  })
  const keyState = await directory.listKeys(resolvedBeamId as BeamIdString)

  if (options.json) {
    console.log(JSON.stringify({ beamId: resolvedBeamId, keyState }, null, 2))
    return
  }

  console.log(chalk.bold(`Keys for ${resolvedBeamId}`))
  console.log(chalk.dim('─'.repeat(60)))
  if (!keyState.active && keyState.revoked.length === 0) {
    console.log(chalk.yellow('No keys recorded'))
    return
  }

  if (keyState.active) {
    console.log(`${chalk.green('ACTIVE')}  ${keyState.active.publicKey}`)
    console.log(chalk.dim(`         created ${new Date(keyState.active.createdAt).toLocaleString()}`))
  }

  for (const revoked of keyState.revoked) {
    console.log(`${chalk.red('REVOKED')} ${revoked.publicKey}`)
    console.log(chalk.dim(`         created ${new Date(revoked.createdAt).toLocaleString()}  revoked ${revoked.revokedAt ? new Date(revoked.revokedAt).toLocaleString() : 'unknown'}`))
  }
}
