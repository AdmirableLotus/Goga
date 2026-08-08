const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[i] = c
    }
    return t
  })()
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crcInput = Buffer.concat([typeBytes, data])
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcInput))
  return Buffer.concat([len, typeBytes, data, crcVal])
}

function isG(x, y, s) {
  const t = Math.round(s * 0.18)
  const r = s
  const ri = r - t
  const dist = Math.sqrt(x * x + y * y)
  const angle = Math.atan2(y, x) * 180 / Math.PI
  if (dist >= ri && dist <= r && !(angle > -45 && angle < 45)) return true
  if (x >= -r && x <= -ri && y >= -r && y <= r) return true
  if (y >= ri && y <= r && x >= -r && x <= r) return true
  if (y >= -r && y <= -ri && x >= -r && x <= r) return true
  if (y >= -t && y <= t && x >= 0 && x <= r) return true
  if (x >= ri && x <= r && y >= 0 && y <= r) return true
  return false
}

function createPNG(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2

  const raw = Buffer.alloc(size * (1 + size * 3))
  const half = size / 2
  const radius = size * 0.45
  const s = Math.round(size * 0.30)

  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const cx = x - half, cy = y - half
      const dist = Math.sqrt(cx * cx + cy * cy)
      let pr = 15, pg = 15, pb = 15
      if (dist < radius) { pr = 124; pg = 106; pb = 247 }
      if (dist < radius * 0.78) { pr = 25; pg = 15; pb = 55 }
      if (isG(Math.round(cx), Math.round(cy), s) && dist < radius * 0.78) {
        pr = 220; pg = 210; pb = 255
      }
      raw[row + 1 + x * 3] = pr
      raw[row + 1 + x * 3 + 1] = pg
      raw[row + 1 + x * 3 + 2] = pb
    }
  }

  const compressed = zlib.deflateSync(raw)
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))])
}

const png256 = createPNG(256)
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png256)
console.log('icon.png written')

const { default: pngToIco } = require('png-to-ico')
pngToIco(path.join(__dirname, '..', 'assets', 'icon.png'))
  .then(buf => {
    fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), buf)
    fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), buf)
    console.log('icon.ico written to assets/ and build/')
  })
  .catch(console.error)
