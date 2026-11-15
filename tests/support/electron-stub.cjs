// Stands in for Electron when tests run under plain Node: the app's data
// folder is a temp dir (set by scripts/test.mjs), and "encryption" is a
// readable tag, which is fine for test data.
const { mkdirSync, mkdtempSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')

const dataDir = process.env.VIBEAPP_TEST_DATA || mkdtempSync(join(tmpdir(), 'vibeapp-test-data-'))
mkdirSync(dataDir, { recursive: true })

const stubComputer = () => globalThis.STUB_COMPUTER || 'this-pc'

module.exports = {
  app: {
    getPath: () => dataDir,
    getVersion: () => '0.0.0-test',
    isPackaged: false
  },
  // Tagged with "this computer's key" (STUB_COMPUTER, changeable by a test), so a test can be
  // another computer: anything made under a different tag can't be opened, as with Windows DPAPI.
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`${stubComputer()}:${text}`, 'utf-8'),
    decryptString: (buffer) => {
      const text = Buffer.from(buffer).toString('utf-8')
      const tag = `${stubComputer()}:`
      if (!text.startsWith(tag)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return text.slice(tag.length)
    }
  }
}
