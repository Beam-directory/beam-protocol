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
    version: '1.6.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'tsx src/index.ts',
      build: 'tsc',
      start: 'node dist/index.js'
    },
    dependencies: {
      'beam-protocol-sdk': '^1.6.0'
    },
    devDependencies: {
      '@types/node': '^20.11.0',
      tsx: '^4.7.1',
      typescript: '^5.3.3'
    }
  }, null, 2) + '\n'
}

const files = (agentName: string, orgName: string, directoryUrl: string) => ({
  'src/index.ts': `import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BeamClient, BeamIdentity, type BeamIdentityData } from 'beam-protocol-sdk'
import { capabilities, registerHandlers } from './handlers.js'

const agentName = process.env.BEAM_AGENT_NAME ?? '${agentName}'
const orgName = process.env.BEAM_ORG ?? '${orgName}'
const directoryUrl = process.env.BEAM_DIRECTORY_URL ?? '${directoryUrl}'
const credentialPath = path.resolve(process.env.BEAM_CREDENTIAL_PATH ?? '.beam/credentials.json')

type CredentialBundle = { identity: BeamIdentityData; apiKey: string }

async function loadCredentials(): Promise<CredentialBundle | null> {
  try {
    const metadata = await stat(credentialPath)
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(\`Credential file must be mode 0600: \${credentialPath}\`)
    }
    const parsed = JSON.parse(await readFile(credentialPath, 'utf8')) as CredentialBundle
    if (!parsed.identity?.beamId || !parsed.apiKey) {
      throw new Error(\`Credential file is incomplete: \${credentialPath}\`)
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function createCredentials(): Promise<BeamClient> {
  const orgApiKey = process.env.BEAM_ORG_API_KEY?.trim()
  if (!orgApiKey) {
    throw new Error('First boot requires BEAM_ORG_API_KEY for the verified organization namespace')
  }

  const identity = BeamIdentity.generate({ agentName, orgName })
  const exported = identity.export()
  const client = new BeamClient({ identity: exported, directoryUrl, apiKey: orgApiKey })
  await client.register(agentName, capabilities)
  if (!client.apiKey) throw new Error('Directory registration did not return an agent API key')

  await mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 })
  await writeFile(credentialPath, \`\${JSON.stringify({ identity: exported, apiKey: client.apiKey }, null, 2)}\\n\`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  return client
}

const stored = await loadCredentials()
const client = stored
  ? new BeamClient({ identity: stored.identity, directoryUrl, apiKey: stored.apiKey })
  : await createCredentials()

registerHandlers(client)
await client.connect()

console.log(\`Connected as \${client.beamId} -> \${directoryUrl}\`)
process.on('SIGINT', () => { client.disconnect(); process.exit(0) })
`,
  'src/handlers.ts': `import type { BeamClient } from 'beam-protocol-sdk'\n\nexport const capabilities = ['conversation.message', 'agent.ping']\n\nexport function registerHandlers(client: BeamClient): void {\n  client.onTalk(async (message, from, respond) => {\n    console.log(\`message from \${from}: \${message}\`)\n    respond(\`Echo from ${agentName}: \${message}\`)\n  })\n\n  client.on('agent.ping', (_frame, respond) => {\n    respond({ success: true, payload: { ok: true, message: 'pong', from: client.beamId } })\n  })\n}\n`,
  '.env.example': `BEAM_AGENT_NAME=${agentName}\nBEAM_ORG=${orgName}\nBEAM_DIRECTORY_URL=${directoryUrl}\nBEAM_CREDENTIAL_PATH=.beam/credentials.json\n# Required only on first boot after organization-domain verification.\nBEAM_ORG_API_KEY=\n`,
  '.gitignore': `.beam/\n.env\n`,
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
  'README.md': `# ${agentName}\n\nMinimal Beam-connected agent scaffolded with create-beam-agent.\n\n## Quickstart\n\n1. Install deps: \`npm install\`\n2. Export the values from \`.env.example\`.\n3. Set \`BEAM_ORG_API_KEY\` to the verified organization's bootstrap key for the first boot.\n4. Run in dev: \`npm run dev\`\n\nThe first boot registers the identity and writes the returned agent credential to \`.beam/credentials.json\` with mode 0600. Later boots reuse that credential and never re-register the Beam ID. Remove the bootstrap organization key from the environment after the first successful boot.\n`
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
