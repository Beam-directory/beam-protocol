import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BeamIdentityData } from '@beam-protocol/sdk'

export interface BeamConfig {
  identity: BeamIdentityData
  directoryUrl: string
  createdAt: string
}

export function getConfigDir(cwd = process.cwd()): string {
  return join(cwd, '.beam')
}

export function getConfigPath(cwd = process.cwd()): string {
  return join(getConfigDir(cwd), 'identity.json')
}

export function configExists(cwd = process.cwd()): boolean {
  return existsSync(getConfigPath(cwd))
}

export function loadOptionalConfig(cwd = process.cwd()): BeamConfig | null {
  const path = getConfigPath(cwd)
  if (!existsSync(path)) {
    return null
  }
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw) as BeamConfig
}

export function loadConfig(cwd = process.cwd()): BeamConfig {
  const config = loadOptionalConfig(cwd)
  if (!config) {
    throw new Error(`No Beam identity found. Run 'beam init' first.`)
  }
  return config
}

export function resolveDirectoryUrl(override?: string, cwd = process.cwd()): string {
  return override ?? loadOptionalConfig(cwd)?.directoryUrl ?? DEFAULT_DIRECTORY_URL
}

export function saveConfig(config: BeamConfig, cwd = process.cwd()): void {
  const dir = getConfigDir(cwd)
  mkdirSync(dir, { recursive: true })
  writeFileSync(getConfigPath(cwd), JSON.stringify(config, null, 2), 'utf8')
}

export const DEFAULT_DIRECTORY_URL = process.env['BEAM_DIRECTORY_URL'] ?? 'https://api.beam.directory'
export const BEAM_ID_PATTERN = /^(?:[a-z0-9_-]+@beam\.directory|[a-z0-9_-]+@[a-z0-9_-]+\.beam\.directory)$/
