// Throwaway diagnostic launcher.
//
// Gives the test instance its own app name, its own userData folder and its own
// single-instance lock, so it can never attach to, or write into, the user's real
// %APPDATA%\goga — and never collides with another instance already running.
//
//   set GOGA_DIAG_USERDATA=<scratch folder>
//   npx electron scripts/diag-main.js --remote-debugging-port=9777
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

const dir = process.env.GOGA_DIAG_USERDATA
if (!dir) {
  console.error('GOGA_DIAG_USERDATA is required')
  process.exit(1)
}
const resolved = path.resolve(dir)
fs.mkdirSync(resolved, { recursive: true })

// A distinct name means a distinct userData path and a distinct instance lock.
app.setName('GogaDiag')
app.setPath('userData', resolved)
app.setPath('sessionData', resolved)

fs.writeFileSync(path.join(resolved, 'diag-boot.txt'),
  `boot ${new Date().toISOString()}\nuserData=${app.getPath('userData')}\nname=${app.getName()}\n`)

require('../dist/main/main/index.js')
