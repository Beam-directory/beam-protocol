import chalk from 'chalk'
import ora from 'ora'
import { BeamClient } from 'beam-protocol-sdk'
import type { BeamIdString } from 'beam-protocol-sdk'
import { BEAM_ID_PATTERN, loadConfig } from '../config.js'

interface TalkOptions {
  directory?: string
  timeout?: string
  language?: string
  context?: string
  json?: boolean
}

function parseContext(contextJson: string | undefined): Record<string, unknown> | undefined {
  if (!contextJson) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(contextJson)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    throw new Error('Context must be a JSON object')
  } catch (err) {
    console.error(chalk.red(`✖ Invalid context JSON: ${(err as Error).message}`))
    process.exit(1)
  }
}

export async function cmdTalk(
  to: string,
  message: string,
  options: TalkOptions
): Promise<void> {
  const config = loadConfig()
  const directoryUrl = options.directory ?? config.directoryUrl
  const timeoutMs = options.timeout ? parseInt(options.timeout, 10) * 1000 : 60_000
  const context = parseContext(options.context)

  if (!BEAM_ID_PATTERN.test(to)) {
    console.error(chalk.red(`✖ Invalid Beam ID: ${to}`))
    console.error(chalk.dim('  Expected: agent@beam.directory or agent@org.beam.directory'))
    process.exit(1)
  }

  if (!message.trim()) {
    console.error(chalk.red('✖ Message must be non-empty'))
    process.exit(1)
  }

  const spinner = ora(`Talking to ${chalk.bold(to)}...`).start()
  const startTime = Date.now()

  try {
    const client = new BeamClient({
      identity: config.identity,
      directoryUrl,
    })

    const reply = await client.talk(to as BeamIdString, message, {
      context,
      language: options.language,
      timeoutMs,
    })
    const elapsed = Date.now() - startTime

    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify(reply, null, 2))
      return
    }

    console.log('')
    console.log(chalk.bold.green('✅ Message delivered successfully'))
    console.log(chalk.dim('─'.repeat(40)))
    console.log(`${chalk.cyan('From:')}    ${config.identity.beamId}`)
    console.log(`${chalk.cyan('To:')}      ${to}`)
    console.log(`${chalk.cyan('Intent:')} conversation.message`)
    console.log(`${chalk.cyan('Latency:')} ${elapsed}ms`)
    console.log('')
    console.log(chalk.bold('💬 Reply:'))
    console.log(reply.message || chalk.dim('(empty response message)'))

    if (reply.structured && Object.keys(reply.structured).length > 0) {
      console.log('')
      console.log(chalk.bold('📦 Structured Data:'))
      console.log(JSON.stringify(reply.structured, null, 2))
    }

    if (reply.threadId) {
      console.log('')
      console.log(`${chalk.cyan('Thread:')} ${reply.threadId}`)
    }

    console.log('')
  } catch (err) {
    spinner.fail('Talk failed')
    console.error(chalk.red(`✖ ${(err as Error).message}`))
    process.exit(1)
  }
}
