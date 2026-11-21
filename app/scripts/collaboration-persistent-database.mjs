import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function command(program, args, options = {}) {
  await new Promise((done, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', windowsHide: true, ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`${program} failed (${signal ?? code}).`)))
  })
}

export async function persistentDatabase(source, signal, dataDirectory = process.env.NOVALIST_COLLAB_TEST_DATA_DIR ?? 'out/manual-persistent-server') {
  const directory = resolve(dataDirectory)
  await mkdir(directory, { recursive: true })
  const settingsPath = resolve(directory, 'postgres-password')
  let password
  try { password = await readFile(settingsPath, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    password = randomBytes(32).toString('hex')
    await writeFile(settingsPath, password, { mode: 0o600, flag: 'wx' })
  }
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('The local test database password file is invalid.')
  const port = Number(process.env.NOVALIST_COLLAB_POSTGRES_PORT ?? 42674)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NOVALIST_COLLAB_POSTGRES_PORT must be a port between 1 and 65535.')
  const project = 'novalist-collaboration-' + createHash('sha256').update(directory).digest('hex').slice(0, 12)
  const compose = ['compose', '--project-name', project, '--file', fileURLToPath(new URL('./collaboration-postgres.compose.yml', import.meta.url))]
  const env = { ...process.env, NOVALIST_COLLAB_POSTGRES_PASSWORD: password, NOVALIST_COLLAB_POSTGRES_PORT: String(port) }
  const close = () => command('docker', [...compose, 'stop'], { env })
  try {
    await command('docker', [...compose, 'up', '--detach', '--wait', '--wait-timeout', '90'], { env, signal })
    const connectionString = `Host=127.0.0.1;Port=${port};Database=novalist_test;Username=novalist_test;Password=${password}`
    await command('dotnet', ['run', '--project', '../eng/CollaborationDatabase/CollaborationDatabase.csproj',
      `-p:SyncServerSource=${source}`], { env: { ...env, NOVALIST_COLLAB_TEST_DATABASE: connectionString }, signal })
    return { connectionString, close }
  } catch (error) {
    try { await close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Persistent test setup failed and PostgreSQL could not be stopped.') }
    throw error
  }
}
