import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { introspectionClient } from './identityProvider.ts'

export async function collaborationServer(authority: string | null, port = 0, tls?: { path: string; password: string },
  options: { source?: string; connectionString?: string } = {}): Promise<{ address: string; close(): Promise<void> }> {
  const source = resolve(options.source ?? process.env.NOVALIST_SYNC_SERVER_SOURCE ?? 'out/collaboration-sync-server')
  if (options.connectionString && !authority) throw new Error('Persistent test hosting requires a sign-in provider.')
  const reservation = createServer()
  reservation.listen(port, '127.0.0.1')
  await once(reservation, 'listening')
  const endpoint = reservation.address()
  if (!endpoint || typeof endpoint === 'string') throw new Error('The test server has no port.')
  const address = `${tls ? 'https' : 'http'}://127.0.0.1:${endpoint.port}`
  await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()))
  const env = {
    ...process.env,
    ASPNETCORE_ENVIRONMENT: 'Development',
    ASPNETCORE_URLS: address,
    Relay__Enabled: String(!options.connectionString),
    ConnectionStrings__Default: options.connectionString ?? '',
    Relay__RequireAuthentication: String(authority !== null),
    Relay__Introspection__Endpoint: authority ? authority + '/introspect' : '',
    Relay__Introspection__ClientId: introspectionClient.id,
    Relay__Introspection__ClientSecret: introspectionClient.secret,
    Authentication__Schemes__Bearer__Authority: authority ?? '',
    Authentication__Schemes__Bearer__ValidAudiences__0: 'novalist',
    Authentication__Schemes__Bearer__RequireHttpsMetadata: String(authority?.startsWith('https:') ?? true),
    Authentication__NativeClient__ClientId: 'novalist',
    Authentication__NativeClient__Scope: 'openid profile sync offline_access',
    Collaboration__ServerUrl: address,
    ...(tls ? { Kestrel__Certificates__Default__Path: tls.path, Kestrel__Certificates__Default__Password: tls.password } : {})
  }
  let child: ChildProcess | undefined
  const close = async (): Promise<void> => {
    if (child?.pid && child.exitCode === null) {
      const exited = once(child, 'exit')
      const force = setTimeout(() => child?.kill('SIGKILL'), 5_000)
      force.unref()
      child.kill()
      try { await exited }
      finally { clearTimeout(force) }
    }
  }
  try {
    child = spawn('dotnet', ['src/Novalist.Sync.Server/bin/Debug/net10.0/Novalist.Sync.Server.dll'],
      { cwd: source, env, windowsHide: true, stdio: options.connectionString ? 'inherit' : 'ignore' })
    let launchError: Error | undefined
    child.on('error', error => { launchError = error })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError
      if (child.exitCode !== null) throw new Error('The collaboration test server exited during startup.')
      const response = await fetch(address + '/client-configuration').catch(() => null)
      if (response?.ok) return { address, close }
      await delay(100)
    }
    throw new Error('The collaboration test server did not become ready.')
  } catch (error) { await close(); throw error }
}
