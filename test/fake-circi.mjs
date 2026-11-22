// A stand-in for the CirCI /v1 API, just enough for `circi upload` and `circi site upload`:
// a real HTTP server, so the CLI runs against real sockets. Only the CirCI server is faked.
//
//   node test/fake-circi.mjs --port 4801 --outcome fail --log requests.jsonl
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/**
 * @param {{ port?: number, outcome?: 'pass' | 'fail', gate?: 'exit-code' | 'status', log?: string }} options
 * `outcome` is what the build's review comes to; `log` is a file that gets one JSON line per request.
 */
export async function startFake({ port = 0, outcome = 'pass', gate = 'exit-code', log } = {}) {
  const requests = []
  let base = ''
  const build = () => ({
    id: 'b1',
    number: 7,
    name: 'default',
    status: 'processing',
    conclusion: null,
    reviewStatus: 'none',
    url: `${base}/builds/7`,
  })

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', 'http://fake')
      let json
      try {
        json = JSON.parse(body.toString('utf8'))
      } catch {
        json = undefined
      }
      const entry = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: req.headers.authorization ?? null,
        json,
      }
      requests.push(entry)
      if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`)
      const reply = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(payload === undefined ? '' : JSON.stringify(payload))
      }
      const { method } = req
      const path = url.pathname
      if (method === 'GET' && path === '/v1/project') {
        reply(200, {
          workspace: 'acme',
          slug: 'web',
          name: 'Web',
          defaultBranch: 'main',
          dashboardUrl: `${base}/acme/web`,
        })
      } else if (method === 'POST' && path === '/v1/builds') {
        const files = Array.isArray(json?.files) ? json.files : []
        reply(200, {
          build: build(),
          uploads: files.map((file) => ({
            sha256: file.sha256,
            url: `${base}/files/${file.sha256}`,
            method: 'PUT',
            headers: { 'content-type': 'image/png' },
            auth: 'none',
          })),
        })
      } else if (method === 'PUT' && path.startsWith('/files/')) {
        reply(200)
      } else if (method === 'POST' && /^\/v1\/builds\/[^/]+\/finalize$/.test(path)) {
        reply(200, { build: build(), complete: true, shardsReceived: 1, shardsTotal: 1 })
      } else if (method === 'GET' && /^\/v1\/builds\/[^/]+\/status$/.test(path)) {
        reply(200, {
          build: { ...build(), status: 'complete' },
          counts: {
            added: 1,
            removed: 0,
            changed: outcome === 'fail' ? 2 : 0,
            unchanged: 3,
            failed: 0,
            total: 6,
          },
          unreadable: [],
          outcome: { state: outcome, summary: outcome === 'pass' ? 'All clear' : 'Changes found' },
          gate,
          errorMessage: null,
        })
      } else if (method === 'GET' && path === '/v1/sites/served') {
        reply(200, { commit: null })
      } else if (method === 'POST' && path === '/v1/sites') {
        reply(200, {
          site: { name: url.searchParams.get('name') ?? 'site', kind: 'storybook', slug: 'web' },
          version: {
            commitSha: url.searchParams.get('commit') ?? '',
            fileCount: 2,
            totalBytes: 10,
          },
          addresses: {
            commit: 'https://abc-web.sites.test',
            branch: 'https://main-web.sites.test',
          },
          branchMoved: true,
          replaced: false,
        })
      } else {
        reply(404, { error: `no route ${method} ${path}` })
      }
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  return {
    url: base,
    requests,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const flags = Object.fromEntries(
    process.argv
      .slice(2)
      .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : [])),
  )
  const fake = await startFake({
    port: Number(flags.port ?? 0),
    outcome: flags.outcome === 'fail' ? 'fail' : 'pass',
    gate: flags.gate === 'status' ? 'status' : 'exit-code',
    log: flags.log,
  })
  console.log(`fake CirCI listening on ${fake.url}`)
}
