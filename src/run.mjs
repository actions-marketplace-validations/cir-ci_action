// Runs @circi/cli for the action: reads the inputs from the environment, uploads, and turns the
// CLI's JSON into step outputs and a job summary. No dependencies, no build step.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const env = process.env
const input = (name) => (env[`INPUT_${name}`] ?? '').trim()

/** Appends `key=value` lines to $GITHUB_OUTPUT; values are single-line. */
function setOutputs(values) {
  if (!env.GITHUB_OUTPUT) return
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value).replaceAll(/[\r\n]+/g, ' ')}`)
  if (lines.length > 0) appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

function writeSummary(markdown) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

function fail(message) {
  console.log(`::error::${message}`)
  process.exit(2)
}

/** Whether this run is a pull request from another repository, which gets no secrets. */
function isForkPullRequest() {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.GITHUB_EVENT_PATH) return false
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    const head = event?.pull_request?.head?.repo?.full_name
    return Boolean(head) && head !== env.GITHUB_REPOSITORY
  } catch {
    return false
  }
}

/** The `--shard` value from the `shard` and `shards` inputs, or undefined. */
function shardFlag(shard, shards) {
  if (!shard && !shards) return undefined
  const value = shard.includes('/') ? shard : `${shard}/${shards}`
  if (!/^\d+\/\d+$/.test(value) || (shard.includes('/') && shards)) {
    fail(
      "Set `shard` to this job's number and `shards` to how many jobs there are (or `shard: 2/4`)",
    )
  }
  return value
}

const quote = (arg) => `"${arg.replaceAll('"', '\\"')}"`

/** Runs the CLI; stderr goes to the job log, stdout comes back. */
function runCli(version, args, cwd, cliEnv) {
  const windows = process.platform === 'win32'
  const all = ['--yes', `@circi/cli@${version}`, ...args]
  return new Promise((done) => {
    const child = spawn(windows ? 'npx.cmd' : 'npx', windows ? all.map(quote) : all, {
      cwd,
      env: cliEnv,
      shell: windows,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', (error) => {
      console.log(`::error::Couldn't run npx: ${error.message}`)
      done({ code: 2, stdout })
    })
    child.on('close', (code) => done({ code: code ?? 2, stdout }))
  })
}

/** The CLI prints its result as JSON on stdout (its progress goes to stderr). */
function parseJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

const STATE_TEXT = {
  uploaded: 'Uploaded',
  passed: 'No changes need review',
  'needs-review': 'Changes need review',
  error: 'Failed',
}

function statusOf(result, code) {
  if (code === 2 || result?.status?.build?.status === 'error') return 'error'
  if (!result) return 'error'
  const state = result.status?.outcome?.state
  if (state === 'fail') return 'needs-review'
  if (state === 'pass') return 'passed'
  return 'uploaded'
}

function screenshotSummary({ result, status, code, title }) {
  const lines = [`### ${title}`, '']
  const build = result?.build
  if (build)
    lines.push(
      `[Build #${build.number}${build.name ? ` (${build.name})` : ''}](${build.url}): **${STATE_TEXT[status]}**`,
    )
  else
    lines.push(
      `**${STATE_TEXT[status]}**: the CLI exited with ${code} before it reported a build. See the log above.`,
    )
  if (result) {
    lines.push(
      '',
      `Uploaded ${result.uploaded} new screenshot${result.uploaded === 1 ? '' : 's'}; ${result.deduplicated} already on the server.`,
    )
    const counts = result.status?.counts
    if (counts) {
      lines.push('', '| Changed | Added | Removed | Unchanged |', '| ---: | ---: | ---: | ---: |')
      lines.push(
        `| ${counts.changed} | ${counts.added} | ${counts.removed} | ${counts.unchanged} |`,
      )
      if (counts.failed > 0)
        lines.push(
          '',
          `${counts.failed} screenshot${counts.failed === 1 ? '' : 's'} couldn't be read.`,
        )
    }
    if (result.status?.outcome?.summary) lines.push('', result.status.outcome.summary)
    if (result.status?.outcome?.warning) lines.push('', `Warning: ${result.status.outcome.warning}`)
  }
  return lines.join('\n')
}

async function main() {
  const path = input('PATH')
  const site = input('SITE')
  const name = input('NAME') || 'default'
  const version = input('CLI_VERSION') || '0.2.0'
  const wait = /^(true|1|yes)$/i.test(input('WAIT'))
  const gate = input('GATE')
  const cwd = resolve(input('WORKING_DIRECTORY') || '.')
  const shard = shardFlag(input('SHARD'), input('SHARDS'))

  if (!path && !site) fail('Set `path` to the screenshots directory, or `site` to a built site')
  if (!/^[\w.^~<>=*|-]+$/.test(version)) fail(`\`cli-version\` isn't a version: ${version}`)
  if (gate && gate !== 'status' && gate !== 'exit-code')
    fail('`gate` must be `status` or `exit-code`')
  if (!/^\d+$/.test(input('TIMEOUT') || '600')) fail('`timeout` is a number of seconds')

  const token = input('TOKEN') || (env.CIRCI_TOKEN ?? '').trim()
  const apiUrl = input('API_URL') || (env.CIRCI_API_URL ?? '').trim()

  if (!token) {
    const fork = isForkPullRequest()
    const message = fork
      ? 'Skipped the CirCI upload: this pull request comes from a fork, and GitHub gives forks no secrets.'
      : 'Skipped the CirCI upload: no token. Pass `token: ${{ secrets.CIRCI_TOKEN }}` (the secret is empty on pull requests from forks and from Dependabot).'
    console.log(`::${fork ? 'notice' : 'warning'} title=CirCI upload skipped::${message}`)
    writeSummary(`### CirCI\n\n${message}`)
    setOutputs({ status: 'skipped' })
    return
  }
  // The runner masks secrets it knows; this covers a token passed some other way.
  console.log(`::add-mask::${token}`)
  if (!apiUrl)
    fail('Set `api-url` (or CIRCI_API_URL) to your CirCI address, for example https://ci.acme.io')

  const cliEnv = { ...env, CIRCI_TOKEN: token, CIRCI_API_URL: apiUrl }
  let exitCode = 0
  const outputs = {}
  const summary = []

  if (path) {
    const args = ['upload', path, '--json', '--name', name, '--timeout', input('TIMEOUT') || '600']
    if (wait) args.push('--wait')
    if (gate) args.push('--gate', gate)
    if (shard) args.push('--shard', shard)
    const { code, stdout } = await runCli(version, args, cwd, cliEnv)
    const result = parseJson(stdout)
    const status = statusOf(result, code)
    exitCode = Math.max(exitCode, code)
    const counts = result?.status?.counts
    Object.assign(outputs, {
      'build-url': result?.build?.url,
      'build-id': result?.build?.id,
      'build-number': result?.build?.number,
      status,
      changed: counts?.changed,
      added: counts?.added,
      removed: counts?.removed,
    })
    summary.push(
      screenshotSummary({ result, status, code, title: `CirCI${shard ? `, shard ${shard}` : ''}` }),
    )
    if (code === 1)
      console.log(
        '::error title=CirCI::Visual changes need review. Review them in the dashboard, then re-run the job.',
      )
    else if (code !== 0)
      console.log(`::error title=CirCI::The upload failed (exit code ${code}). See the log above.`)
  }

  if (site) {
    const args = [
      'site',
      'upload',
      site,
      '--name',
      input('SITE_NAME') || 'site',
      '--kind',
      input('SITE_KIND') || 'auto',
    ]
    const { code, stdout } = await runCli(version, args, cwd, cliEnv)
    process.stdout.write(stdout)
    exitCode = Math.max(exitCode, code)
    const commit = /^\s*commit:\s+(\S+)/m.exec(stdout)?.[1]
    const branch = /^\s*branch:\s+(\S+)/m.exec(stdout)?.[1]
    outputs['site-url'] = commit
    if (!path) outputs.status = code === 0 ? 'uploaded' : 'error'
    if (code === 0 && commit) {
      summary.push(
        `### CirCI site\n\n${input('SITE_NAME') || 'site'} is hosted at ${commit}${branch ? `\n\nThe branch address is ${branch}.` : ''}`,
      )
    } else {
      summary.push(`### CirCI site\n\n**Failed**: the CLI exited with ${code}. See the log above.`)
      console.log(
        `::error title=CirCI site::The site upload failed (exit code ${code}). See the log above.`,
      )
    }
  }

  setOutputs(outputs)
  writeSummary(summary.join('\n\n'))
  process.exitCode = exitCode
}

await main()
