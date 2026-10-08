#!/usr/bin/env node

import { execSync } from 'node:child_process'

const version = execSync('npm -v', { encoding: 'utf8' }).trim()
const major = Number(version.split('.')[0])
if (!Number.isInteger(major) || major < 10) {
  console.error(`npm ${version} is too old; this repository requires npm >= 10`)
  process.exit(1)
}
