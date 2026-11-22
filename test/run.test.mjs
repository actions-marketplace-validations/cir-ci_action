// Runs the action's script (src/run.mjs) against the fake CirCI server with the real @circi/cli
// from npm. Only the CirCI server is faked: real services are never contacted.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startFake } from './fake-circi.mjs'

const root = resolve(fileURLToPath(import.meta.url), '../..')
const script = join(root, 'src/run.mjs')
const TOKEN = 'circi_test_token_0123456789'

/** The parent's environment without anything that steers the CLI's CI detection. */
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GITHUB_|CIRCI_|INPUT_|RUNNER_|CI$)/.test(key),
    ),
  )
}

/** Runs the script with these inputs; returns its exit code, log, outputs and summary. */
async function runAction(inputs, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'circi-action-'))
  const outputFile = join(dir, 'output')
  const summaryFile = join(dir, 'summary.md')
  writeFileSync(outputFile, '')
  writeFileSync(summaryFile, '')
  const env = {
    ...cleanEnv(),
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    CIRCI_COMMIT: 'a'.repeat(40),
    CIRCI_BRANCH: 'feature',
    GITHUB_RUN_ID: '99',
    ...Object.fromEntries(Object.entries(inputs).map(([key, value]) => [`INPUT_${key}`, value])),
    ...extraEnv,
  }
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => {
    log += chunk
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
  })
  const code = await new Promise((done) => child.on('close', done))
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
  return { code, log, outputs, summary: readFileSync(summaryFile, 'utf8') }
}

describe('the action script', () => {
  let fake
  let failing

  before(async () => {
    fake = await startFake({ outcome: 'pass' })
    failing = await startFake({ outcome: 'fail' })
  })
  after(async () => {
    await fake.stop()
    await failing.stop()
  })

  const base = (server) => ({
    PATH: 'test/fixtures/screenshots',
    TOKEN,
    API_URL: server.url,
    CLI_VERSION: '0.2.0',
  })

  test('uploads and waits: outputs and summary', async () => {
    const result = await runAction({ ...base(fake), WAIT: 'true', NAME: 'chromium' })
    assert.equal(result.code, 0, result.log)
    assert.deepEqual(
      {
        status: result.outputs.status,
        url: result.outputs['build-url'],
        id: result.outputs['build-id'],
        number: result.outputs['build-number'],
        changed: result.outputs.changed,
        added: result.outputs.added,
      },
      {
        status: 'passed',
        url: `${fake.url}/builds/7`,
        id: 'b1',
        number: '7',
        changed: '0',
        added: '1',
      },
    )
    assert.match(
      result.summary,
      /\[Build #7 \(default\)\]\(.*\/builds\/7\): \*\*No changes need review\*\*/,
    )
    assert.match(result.summary, /\| 0 \| 1 \| 0 \| 3 \|/)
    const create = fake.requests.findLast((r) => r.path === '/v1/builds')
    assert.equal(create.json.name, 'chromium')
    assert.equal(create.authorization, `Bearer ${TOKEN}`)
  })

  test('masks the token and never prints it', async () => {
    const result = await runAction({ ...base(fake) })
    assert.equal(result.code, 0, result.log)
    assert.ok(result.log.includes(`::add-mask::${TOKEN}`))
    assert.equal(result.log.replace(`::add-mask::${TOKEN}`, '').includes(TOKEN), false)
    assert.equal(result.summary.includes(TOKEN), false)
  })

  test('without wait: status uploaded, no counts', async () => {
    const result = await runAction({ ...base(fake) })
    assert.equal(result.code, 0, result.log)
    assert.equal(result.outputs.status, 'uploaded')
    assert.equal(result.outputs.changed, undefined)
    assert.match(result.summary, /Uploaded|\*\*Uploaded\*\*/)
  })

  test('wait fails the job while changes need review', async () => {
    const result = await runAction({ ...base(failing), WAIT: 'true' })
    assert.equal(result.code, 1, result.log)
    assert.equal(result.outputs.status, 'needs-review')
    assert.equal(result.outputs.changed, '2')
    assert.match(result.summary, /Changes need review/)
    assert.match(result.log, /::error title=CirCI::Visual changes need review/)
  })

  test('gate status: needs review, job passes', async () => {
    const statusGate = await startFake({ outcome: 'fail', gate: 'status' })
    try {
      const result = await runAction({ ...base(statusGate), WAIT: 'true', GATE: 'status' })
      assert.equal(result.code, 0, result.log)
      assert.equal(result.outputs.status, 'needs-review')
      assert.ok(
        statusGate.requests.some((r) => r.path.endsWith('/status') && r.query.gate === 'status'),
      )
    } finally {
      await statusGate.stop()
    }
  })

  test('shard and shards join one build', async () => {
    const result = await runAction({ ...base(fake), SHARD: '2', SHARDS: '4' })
    assert.equal(result.code, 0, result.log)
    const create = fake.requests.findLast((r) => r.path === '/v1/builds')
    assert.deepEqual(create.json.parallel, { nonce: '99', total: 4 })
    const finalize = fake.requests.findLast((r) => r.path.endsWith('/finalize'))
    assert.equal(finalize.json.shardIndex, '1')
    assert.match(result.summary, /shard 2\/4/)
  })

  test('shard written as n/total', async () => {
    const result = await runAction({ ...base(fake), SHARD: '3/4' })
    assert.equal(result.code, 0, result.log)
    assert.deepEqual(fake.requests.findLast((r) => r.path === '/v1/builds').json.parallel, {
      nonce: '99',
      total: 4,
    })
  })

  test('uploads a hosted site', async () => {
    const result = await runAction({
      TOKEN,
      API_URL: fake.url,
      CLI_VERSION: '0.2.0',
      SITE: 'test/fixtures/site',
      SITE_NAME: 'storybook',
    })
    assert.equal(result.code, 0, result.log)
    assert.equal(result.outputs['site-url'], 'https://abc-web.sites.test')
    assert.equal(result.outputs.status, 'uploaded')
    assert.match(result.summary, /storybook is hosted at https:\/\/abc-web\.sites\.test/)
    assert.equal(fake.requests.findLast((r) => r.path === '/v1/sites').query.name, 'storybook')
  })

  test('uses the CIRCI_TOKEN and CIRCI_API_URL environment when the inputs are empty', async () => {
    const result = await runAction(
      { PATH: 'test/fixtures/screenshots' },
      { CIRCI_TOKEN: TOKEN, CIRCI_API_URL: fake.url },
    )
    assert.equal(result.code, 0, result.log)
    assert.equal(result.outputs.status, 'uploaded')
  })

  test('skips with a notice on a pull request from a fork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circi-event-'))
    const eventPath = join(dir, 'event.json')
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { head: { repo: { full_name: 'someone/fork' } } } }),
    )
    const before = fake.requests.length
    const result = await runAction(
      { PATH: 'test/fixtures/screenshots', API_URL: fake.url },
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: 'cir-ci/action',
      },
    )
    assert.equal(result.code, 0, result.log)
    assert.equal(result.outputs.status, 'skipped')
    assert.match(result.log, /::notice title=CirCI upload skipped::.*fork/)
    assert.match(result.summary, /fork/)
    assert.equal(fake.requests.length, before)
  })

  test('skips with a warning when there is no token outside a fork', async () => {
    const result = await runAction({ PATH: 'test/fixtures/screenshots', API_URL: fake.url })
    assert.equal(result.code, 0, result.log)
    assert.equal(result.outputs.status, 'skipped')
    assert.match(result.log, /::warning title=CirCI upload skipped::.*no token/)
  })

  test('a pull request from the same repository is not a fork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circi-event-'))
    const eventPath = join(dir, 'event.json')
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { head: { repo: { full_name: 'cir-ci/action' } } } }),
    )
    const result = await runAction(
      { PATH: 'test/fixtures/screenshots', API_URL: fake.url },
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: 'cir-ci/action',
      },
    )
    assert.match(result.log, /::warning title=CirCI upload skipped::/)
  })

  test('fails on missing or wrong inputs', async () => {
    const none = await runAction({ TOKEN, API_URL: fake.url })
    assert.equal(none.code, 2)
    assert.match(none.log, /::error::Set `path`/)

    const lone = await runAction({ ...base(fake), SHARD: '2' })
    assert.equal(lone.code, 2)
    assert.match(lone.log, /::error::Set `shard`/)

    const noUrl = await runAction({ PATH: 'test/fixtures/screenshots', TOKEN })
    assert.equal(noUrl.code, 2)
    assert.match(noUrl.log, /::error::Set `api-url`/)

    const badGate = await runAction({ ...base(fake), GATE: 'nope' })
    assert.equal(badGate.code, 2)
  })

  test('reports a CLI failure with its exit code and an error status', async () => {
    const result = await runAction({ ...base(fake), PATH: 'test/fixtures/missing' })
    assert.equal(result.code, 2)
    assert.equal(result.outputs.status, 'error')
    assert.match(result.log, /::error title=CirCI::The upload failed \(exit code 2\)/)
    assert.match(result.summary, /Failed/)
  })
})
