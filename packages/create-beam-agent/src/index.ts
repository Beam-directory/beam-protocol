#!/usr/bin/env node

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import prompts from 'prompts'

const DEFAULT_DIRECTORY_URL = 'https://api.beam.directory'
const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
const valid = (value: string) => /^[a-z0-9_-]+$/.test(value)

function renderPackageJson(name: string): string {
  return JSON.stringify({
    name,
    version: '0.7.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'tsx src/index.ts',
      build: 'tsc',
      start: 'node dist/index.js'
    },
    dependencies: {
      'beam-protocol-sdk': '^0.7.0'
    },
    devDependencies: {
      '@types/node': '^20.11.0',
      tsx: '^4.7.1',
      typescript: '^5.3.3'
    }
  }, null, 2) + '\n'
}

const files = (agentName: string, orgName: string, directoryUrl: string) => ({
  'src/index.ts': `import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'\nimport { capabilities, registerHandlers } from './handlers.js'\n\nconst agentName = process.env.BEAM_AGENT_NAME ?? '${agentName}'\nconst orgName = process.env.BEAM_ORG ?? '${orgName}'\nconst directoryUrl = process.env.BEAM_DIRECTORY_URL ?? '${directoryUrl}'\n\nconst identity = BeamIdentity.generate({ agentName, orgName })\nconst client = new BeamClient({ identity: identity.export(), directoryUrl })\n\nregisterHandlers(client)\nawait client.register(agentName, capabilities)\nawait client.connect()\n\nconsole.log(\`Connected as \${client.beamId} -> \${directoryUrl}\`)\nprocess.on('SIGINT', () => { client.disconnect(); process.exit(0) })\n`,
  'src/handlers.ts': `import type { BeamClient } from 'beam-protocol-sdk'\n\nexport const capabilities = ['conversation.message', 'agent.ping']\n\nexport function registerHandlers(client: BeamClient): void {\n  client.onTalk(async (message, from, respond) => {\n    console.log(\`message from \${from}: \${message}\`)\n    respond(\`Echo from ${agentName}: \${message}\`)\n  })\n\n  client.on('agent.ping', (_frame, respond) => {\n    respond({ success: true, payload: { ok: true, message: 'pong', from: client.beamId } })\n  })\n}\n`,
  '.env.example': `BEAM_AGENT_NAME=${agentName}\nBEAM_ORG=${orgName}\nBEAM_DIRECTORY_URL=${directoryUrl}\n`,
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
  'README.md': `# ${agentName}\n\nMinimal Beam-connected agent scaffolded with create-beam-agent.\n\n## Quickstart\n\n1. Install deps: \`npm install\`\n2. Optionally export values from \`.env.example\`\n3. Run in dev: \`npm run dev\`\n\nThe example agent generates a local Beam identity, registers with the directory, echoes \`conversation.message\`, and answers \`agent.ping\` with \`pong\`.\n`
})

async function main(): Promise<void> {
  const response = await prompts([
    {
      type: 'text',
      name: 'agentName',
      message: 'Agent name',
      validate: (value: string) => valid(slug(value)) ? true : 'Use letters, numbers, underscores, or hyphens'
    },
    {
      type: 'text',
      name: 'orgName',
      message: 'Org name',
      validate: (value: string) => valid(slug(value)) ? true : 'Use letters, numbers, underscores, or hyphens'
    },
    {
      type: 'text',
      name: 'directoryUrl',
      message: 'Beam directory URL',
      initial: DEFAULT_DIRECTORY_URL,
      validate: (value: string) => value.startsWith('http://') || value.startsWith('https://') ? true : 'Use http:// or https://'
    }
  ], { onCancel: () => { process.exit(1) } })

  const agentName = slug(response.agentName)
  const orgName = slug(response.orgName)
  const directoryUrl = response.directoryUrl.trim() || DEFAULT_DIRECTORY_URL
  const targetDir = path.resolve(process.cwd(), agentName)

  if (!agentName || !orgName) {
    console.error('Agent name and org name are required.')
    process.exit(1)
  }

  try {
    const entries = await readdir(targetDir)
    if (entries.length > 0) {
      console.error(`Target directory already exists and is not empty: ${targetDir}`)
      process.exit(1)
    }
  } catch {
    await mkdir(targetDir, { recursive: true })
  }

  const projectFiles = files(agentName, orgName, directoryUrl)
  await mkdir(path.join(targetDir, 'src'), { recursive: true })
  await Promise.all([
    writeFile(path.join(targetDir, 'package.json'), renderPackageJson(agentName)),
    ...Object.entries(projectFiles).map(([file, contents]) => writeFile(path.join(targetDir, file), contents))
  ])

  console.log(`Created ${agentName} in ${targetDir}`)
  console.log(`Next: cd ${agentName} && npm install && npm run dev`)
}

await main()
