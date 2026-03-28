import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from 'beam-protocol-sdk'
import { loadConfig } from '../config.js'

interface ProfileUpdateOptions {
  description?: string
  logoUrl?: string
  website?: string
  directory?: string
  json?: boolean
}

export async function cmdProfileUpdate(options: ProfileUpdateOptions): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const spinner = ora(`Updating profile for ${chalk.bold(config.identity.beamId)}...`).start()

  try {
    const client = new BeamClient({ identity: config.identity, directoryUrl })
    const profile = await client.updateProfile({
      description: options.description,
      logo_url: options.logoUrl,
      website: options.website,
    })

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(profile, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold.green('✅ Profile updated'))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('Beam ID:')}      ${profile.beamId}`)
    console.log(`${chalk.cyan('Description:')} ${profile.description ?? chalk.dim('—')}`)
    console.log(`${chalk.cyan('Logo URL:')}    ${profile.logoUrl ?? chalk.dim('—')}`)
    console.log(`${chalk.cyan('Website:')}     ${profile.website ?? chalk.dim('—')}`)
    console.log('')
  } catch (err) {
    spinner.fail('Profile update failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
