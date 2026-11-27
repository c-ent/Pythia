// Prints the lines for .env: an argon2id hash of a new password, an MCP
// bearer token, and PYTHIA_SECRETS_KEY (T39), which encrypts secrets saved in
// the database. Web sessions live in the database (T36), so there is no
// session secret. The password is read without echo
// from a terminal, or from stdin when piped; it is never printed.
//   pnpm --filter server auth-env
import process, { stderr, stdin, stdout } from 'node:process'
import { hashPassword } from './password.js'
import { generateSecretsKey } from './secretBox.js'
import { randomSecret } from './tokens.js'

const MIN_LENGTH = 12

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stderr.write(prompt)
    let value = ''
    const finish = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stderr.write('\n')
    }
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish()
          resolve(value)
          return
        }
        if (char === '\u0003') {
          finish()
          reject(new Error('cancelled'))
          return
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.resume()
  })
}

function fail(message: string): never {
  stderr.write(`${message}\n`)
  process.exit(1)
}

let password: string
if (stdin.isTTY) {
  password = await readHidden('New Pythia password: ')
  if ((await readHidden('Repeat it: ')) !== password) fail('The passwords do not match.')
} else {
  password = await readPiped()
}
if ([...password].length < MIN_LENGTH) fail(`Use at least ${MIN_LENGTH} characters.`)

const hash = await hashPassword(password)
stderr.write('Add these lines to .env. Keep the single quotes: the hash contains $.\n')
stderr.write('PYTHIA_SECRETS_KEY encrypts the Gemini key saved in Settings: keep it with your backups,\n')
stderr.write('or a restored database cannot open the saved key. Skip that line if .env already has one.\n')
stdout.write(
  `PYTHIA_PASSWORD_HASH='${hash}'\nPYTHIA_MCP_TOKEN=${randomSecret()}\nPYTHIA_SECRETS_KEY=${generateSecretsKey()}\n`,
)
