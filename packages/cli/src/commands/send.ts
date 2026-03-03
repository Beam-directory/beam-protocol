import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from '@beam-protocol/sdk'
import type { BeamIdString } from '@beam-protocol/sdk'
import { loadConfig } from '../config.js'

interface SendOptions {
  directory?: string
  timeout?: string
  json?: boolean
}

export async function cmdSend(
  to: string,
  intent: string,
  paramsJson: string | undefined,
  options: SendOptions
): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const timeoutMs = options.timeout ? parseInt(options.timeout, 10) * 1000 : 10000

  // Validate beam ID format
  if (!to.match(/^[a-z0-9_-]+@[a-z0-9_-]+\.beam\.directory$/)) {
    console.error(chalk.red(`✖ Invalid Beam ID: ${to}`))
    console.error(chalk.dim('  Expected: agent@org.beam.directory'))
    process.exit(1)
  }

  // Parse params
  let params: Record<string, unknown> = {}
  if (paramsJson) {
    try {
      const parsed: unknown = JSON.parse(paramsJson)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>
      } else {
        throw new Error('Params must be a JSON object')
      }
    } catch (err) {
      console.error(chalk.red(`✖ Invalid params JSON: ${(err as Error).message}`))
      process.exit(1)
    }
  }

  const spinner = ora(
    `Sending ${chalk.bold(intent)} to ${chalk.bold(to)}...`
  ).start()

  const startTime = Date.now()

  try {
    const client = new BeamClient({
      identity: config.identity,
      directoryUrl
    })

    const result = await client.send(to as BeamIdString, intent, params, timeoutMs)
    const elapsed = Date.now() - startTime

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    if (result.success) {
      console.log('')
      console.log(chalk.bold.green('✅ Intent delivered successfully'))
      console.log(chalk.dim('─'.repeat(40)))
      console.log(`${chalk.cyan('From:')}    ${config.identity.beamId}`)
      console.log(`${chalk.cyan('To:')}      ${to}`)
      console.log(`${chalk.cyan('Intent:')} ${intent}`)
      console.log(`${chalk.cyan('Latency:')} ${elapsed}ms`)
      if (result.payload && Object.keys(result.payload).length > 0) {
        console.log('')
        console.log(chalk.bold('📦 Result Payload:'))
        console.log(JSON.stringify(result.payload, null, 2))
      }
    } else {
      console.log('')
      console.log(chalk.bold.red('✖ Intent failed'))
      console.log(chalk.dim('─'.repeat(40)))
      console.log(`${chalk.cyan('Error:')}     ${result.error ?? 'Unknown error'}`)
      if (result.errorCode) {
        console.log(`${chalk.cyan('Code:')}      ${result.errorCode}`)
      }
      console.log(`${chalk.cyan('Latency:')} ${elapsed}ms`)
    }
    console.log('')
  } catch (err) {
    spinner.fail('Send failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
