import chalk from 'chalk'
import ora from 'ora'
import { BeamIdentity } from '@beam-protocol/sdk'
import { configExists, saveConfig, DEFAULT_DIRECTORY_URL } from '../config.js'

interface InitOptions {
  agent: string
  org: string
  force?: boolean
  directory?: string
}

export async function cmdInit(options: InitOptions): Promise<void> {
  const { agent, org, force, directory = DEFAULT_DIRECTORY_URL } = options

  // Validate inputs
  if (!/^[a-z0-9_-]+$/.test(agent)) {
    console.error(chalk.red('✖ Agent name must match [a-z0-9_-]'))
    process.exit(1)
  }
  if (!/^[a-z0-9_-]+$/.test(org)) {
    console.error(chalk.red('✖ Org name must match [a-z0-9_-]'))
    process.exit(1)
  }

  if (configExists() && !force) {
    console.error(chalk.yellow('⚠ Identity already exists at .beam/identity.json'))
    console.error(chalk.dim('  Use --force to overwrite'))
    process.exit(1)
  }

  const spinner = ora('Generating Ed25519 keypair...').start()

  const identity = BeamIdentity.generate({ agentName: agent, orgName: org })
  const identityData = identity.export()

  saveConfig({
    identity: identityData,
    directoryUrl: directory,
    createdAt: new Date().toISOString()
  })

  spinner.succeed('Identity generated')

  console.log('')
  console.log(chalk.bold('🔑 Beam Identity Created'))
  console.log(chalk.dim('─'.repeat(40)))
  console.log(`${chalk.cyan('Beam ID:')}     ${chalk.bold(identityData.beamId)}`)
  console.log(`${chalk.cyan('Directory:')}   ${directory}`)
  console.log(`${chalk.cyan('Config:')}      ${process.cwd()}/.beam/identity.json`)
  console.log('')
  console.log(chalk.dim('Public key (SPKI/DER/base64):'))
  console.log(chalk.dim(identityData.publicKeyBase64.substring(0, 64) + '...'))
  console.log('')
  console.log(chalk.yellow('⚠  Keep .beam/identity.json secret — it contains your private key!'))
  console.log(chalk.dim('   Add .beam/ to your .gitignore'))
  console.log('')
  console.log(chalk.green('Next step:'), `beam register --display-name "My Agent" --capabilities "query,answer"`)
}
