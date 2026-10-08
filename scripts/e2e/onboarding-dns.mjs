/**
 * Tiny UDP DNS for the onboarding e2e. The directory calls node:dns resolveTxt, so the
 * directory process must start with NODE_OPTIONS=--import ./onboarding-dns-preload.mjs.
 * Hostnames and TXT values live in a JSON file the server re-reads on every query.
 */
import { createSocket } from 'node:dgram'
import { readFileSync } from 'node:fs'

export function loadTxtMap(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const map = new Map()
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string') map.set(name.toLowerCase(), value)
    }
    return map
  } catch {
    return new Map()
  }
}

function readName(buf, offset) {
  const labels = []
  let pos = offset
  let end = offset
  let jumped = false
  for (let hops = 0; hops < 16 && pos < buf.length; hops += 1) {
    const len = buf[pos]
    if (len === 0) {
      if (!jumped) end = pos + 1
      return { name: labels.join('.').toLowerCase(), end }
    }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = pos + 2
      pos = ((len & 0x3f) << 8) | buf[pos + 1]
      jumped = true
      continue
    }
    pos += 1
    labels.push(buf.subarray(pos, pos + len).toString('ascii'))
    pos += len
    if (!jumped) end = pos
  }
  return { name: labels.join('.').toLowerCase(), end }
}

function answer(query, txt) {
  const { name, end } = readName(query, 12)
  if (end <= 12 || end + 4 > query.length) return null
  const type = query.readUInt16BE(end)
  const question = query.subarray(12, end + 4)
  const id = query.readUInt16BE(0)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  const found = type === 16 && txt.has(name)
  // QR | AA | RD
  header.writeUInt16BE(0x8400 | (found ? 0 : 0x0003), 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(found ? 1 : 0, 6)
  if (!found) return Buffer.concat([header, question])

  const value = Buffer.from(txt.get(name), 'utf8')
  const rdata = Buffer.concat([Buffer.from([value.length]), value])
  const rr = Buffer.alloc(12 + rdata.length)
  rr.writeUInt16BE(0xc00c, 0)
  rr.writeUInt16BE(16, 2)
  rr.writeUInt16BE(1, 4)
  rr.writeUInt32BE(30, 6)
  rr.writeUInt16BE(rdata.length, 10)
  rdata.copy(rr, 12)
  return Buffer.concat([header, question, rr])
}

export function startTxtServer(file, port = 5353) {
  const socket = createSocket('udp4')
  socket.on('message', (message, remote) => {
    const response = answer(message, loadTxtMap(file))
    if (response) socket.send(response, remote.port, remote.address)
  })
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, '127.0.0.1', () => resolve(socket))
  })
}
