import type { EngineInterface } from 'claude-code'
import { closeTerminal, type HcListed, listTerminals } from './hc'
import { session } from './session'
import { dropOldJobs, jobs } from './state'

// Every `pruneMinutes`, and on the prune command: removes the linked worktrees of the
// repos this session's workers used once their branch's PR is merged on GitHub, the
// tree is clean and no terminal there is working or blocked. Closes those workers' terminals
// and deletes the local branch. Ignored files (node_modules, target) go with the tree;
// anything uncommitted keeps it.
let pruning = false

export async function pruneMerged($: EngineInterface): Promise<string[]> {
  if (pruning) return []
  pruning = true
  const done: string[] = []
  try {
    const run = async (args: string[], timeoutMs = 60_000): Promise<string | undefined> => {
      const r = await $.process.run(args, { timeoutMs })
      return r.exitCode === 0 ? r.stdout.trim() : undefined
    }
    await dropOldJobs($)
    const commons = new Set<string>()
    // One rev-parse per folder, however many jobs ran there.
    for (const cwd of new Set(Object.values(await jobs($)).map(j => j.cwd))) {
      if (!(await $.fs.exists(cwd))) continue
      const c = await run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (c) commons.add(c)
    }
    if (commons.size === 0) return done

    // Every live terminal in a tree keeps it while it works, whoever started it; only the workers
    // this mod started (labelled) are closed.
    let agents: HcListed[]
    const mine = new Set<string>()
    try {
      agents = await listTerminals($)
      for (const w of await listTerminals($, ['herdr-agents.role=worker'])) mine.add(w.address)
    } catch {
      // Without both lists nothing is known about who is in a tree: no pass.
      return done
    }
    const inside = (wt: string) => agents.filter(a => a.cwd === wt || String(a.cwd ?? '').startsWith(`${wt}/`))

    for (const common of commons) {
      const list = (await run(['git', `--git-dir=${common}`, 'worktree', 'list', '--porcelain'])) ?? ''
      // The first entry is the main checkout, never removed.
      const trees = list
        .split('\n\n')
        .slice(1)
        .map(block => ({
          path: block.match(/^worktree (.+)$/m)?.[1],
          branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
        }))
      for (const { path, branch } of trees) {
        if (!path || !branch || !(await $.fs.exists(path))) continue
        const here = inside(path)
        // Only a labelled worker that is idle, done or error is safe to close; any other terminal keeps the tree.
        if (here.some(a => !mine.has(a.address) || !['idle', 'done', 'error'].includes(a.status ?? ''))) continue
        if ((await run(['git', '-C', path, 'status', '--porcelain'])) !== '') continue
        const remotes = (await run(['git', '-C', path, 'remote', '-v'])) ?? ''
        const slug = remotes.match(/github\.com[:/]([^/\s]+\/[^\s]+?)(?:\.git)?\s/)?.[1]
        if (!slug) continue
        const pr = await run([
          'gh',
          'pr',
          'list',
          '--repo',
          slug,
          '--head',
          branch,
          '--state',
          'merged',
          '--json',
          'number,headRefOid',
          '--jq',
          '.[0] | "\\(.number) \\(.headRefOid)"',
        ])
        const [merged, mergedHead] = (pr ?? '').split(' ')
        if (!merged || !mergedHead) continue
        // Commits made after the merge exist only here: keep the tree.
        if ((await run(['git', '-C', path, 'rev-parse', 'HEAD'])) !== mergedHead) continue

        for (const a of here) {
          if (!mine.has(a.address)) continue
          try {
            await closeTerminal($, a.address)
          } catch {}
        }
        if ((await run(['git', `--git-dir=${common}`, 'worktree', 'remove', path], 300_000)) === undefined) continue
        await run(['git', `--git-dir=${common}`, 'branch', '-D', branch])
        done.push(`${path.split('/').pop()} (${slug.split('/').pop()}#${merged})`)
      }
    }
    if (done.length) $.ui.toast(`Removed ${done.length} merged worktree${done.length === 1 ? '' : 's'}: ${done.join(', ')}`)
    return done
  } finally {
    pruning = false
  }
}

export async function excludeFromGit($: EngineInterface, cwd: string) {
  const ran = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])
  if (ran.exitCode !== 0) return
  const path = ran.stdout.trim()
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  if (!text.split('\n').includes('.herdr-agents/')) await $.fs.write(path, `${text.replace(/\n?$/, '\n')}.herdr-agents/\n`)
}

// Where spawn puts a worker's worktree: next to the repo, in <repo>-wt, one folder per branch.
export const worktreePath = (top: string, branch: string) => {
  const at = top.lastIndexOf('/')
  return `${top.slice(0, at)}/${top.slice(at + 1)}-wt/${branch.replaceAll('/', '-')}`
}

async function git($: EngineInterface, args: string[], timeoutMs = 10_000) {
  try {
    const r = await $.process.run(['git', ...args], { timeoutMs })
    return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() }
  } catch (err) {
    return { ok: false, out: '', err: String(err) }
  }
}

// The checkout `repo` names (default: the coordinator's folder), or undefined when it is not one.
export async function repoTop($: EngineInterface, repo?: string) {
  const dir = !repo ? session.cwd : repo.startsWith('/') ? repo : `${session.cwd}/${repo}`
  const r = await git($, ['-C', dir, 'rev-parse', '--show-toplevel'])
  return r.ok && r.out ? r.out : undefined
}

// The branch origin/HEAD points to; else, only in a repo with no origin remote, the branch the checkout is on; else main.
export async function defaultBase($: EngineInterface, top: string) {
  const r = await git($, ['-C', top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const head = r.ok && r.out.replace(/^origin\//, '')
  if (head) return head
  if ((await git($, ['-C', top, 'remote', 'get-url', 'origin'])).ok) return 'main'
  const on = await git($, ['-C', top, 'branch', '--show-current'])
  return (on.ok && on.out) || 'main'
}

// The quick, local checks before a worktree is made. Returns a denial reason, or whether the folder
// is already the worktree on that branch (then nothing is fetched or added).
export async function checkWorktree(
  $: EngineInterface,
  top: string,
  branch: string,
  path: string,
): Promise<{ deny: string } | { reuse: boolean }> {
  if (!(await validBranch($, branch))) return { deny: `${branch} is not a valid branch name` }
  if (await $.fs.exists(path)) {
    const mine = await git($, ['-C', top, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const there = await git($, ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const on = await git($, ['-C', path, 'branch', '--show-current'])
    if (mine.ok && there.ok && mine.out === there.out && on.ok && on.out === branch) return { reuse: true }
    return { deny: `${path} exists and is not a worktree of ${top} on ${branch}; pass cwd to use it, or pick another branch` }
  }
  const list = await git($, ['-C', top, 'worktree', 'list', '--porcelain'])
  for (const block of list.out.split('\n\n')) {
    if (block.match(/^branch refs\/heads\/(.+)$/m)?.[1] !== branch) continue
    const where = block.match(/^worktree (.+)$/m)?.[1]
    return { deny: `${branch} is already checked out in ${where}; pass cwd=${where} to use it` }
  }
  return { reuse: false }
}

// Whether `name` can be a branch name (git check-ref-format --branch; a name that starts with - fails).
export async function validBranch($: EngineInterface, name: string) {
  return (await git($, ['check-ref-format', '--branch', name])).ok
}

// Fetches the base and the branch, and adds the worktree: on the local branch if there is one, else on origin's, else a
// new branch off origin/<base>. A repo with no origin remote fetches nothing and branches off the local <base>.
// Throws with git's error.
export async function createWorktree($: EngineInterface, top: string, branch: string, base: string, path: string) {
  // Both names are checked again here: a name that starts with - would reach git as an option.
  for (const name of [base, branch]) if (!(await validBranch($, name))) throw new Error(`${name} is not a valid branch name`)
  const remote = (await git($, ['-C', top, 'remote', 'get-url', 'origin'])).ok
  if (remote) {
    const fetched = await git($, ['-C', top, 'fetch', 'origin', base], 120_000)
    if (!fetched.ok) throw new Error(`git fetch origin ${base} failed: ${fetched.err || fetched.out}`)
    // The branch may live only on the remote, or be older here; a failure (no such branch yet) is fine.
    if (branch !== base) await git($, ['-C', top, 'fetch', 'origin', branch], 120_000)
  }
  const has = async (ref: string) => (await git($, ['-C', top, 'rev-parse', '--verify', '--quiet', ref])).ok
  const args = (await has(`refs/heads/${branch}`))
    ? ['worktree', 'add', path, branch]
    : remote && (await has(`refs/remotes/origin/${branch}`))
      ? ['worktree', 'add', '-b', branch, path, `origin/${branch}`]
      : ['worktree', 'add', '-b', branch, path, remote ? `origin/${base}` : `refs/heads/${base}`]
  const added = await git($, ['-C', top, ...args], 120_000)
  if (!added.ok) throw new Error(`git ${args.join(' ')} failed: ${added.err || added.out}`)
}
