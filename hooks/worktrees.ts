import type { EngineInterface } from 'claude-code'
import { herdr, type HerdrAgent } from './herdr'
import { jobs } from './state'

// Every `pruneMinutes`, and on the prune command: removes the linked worktrees of the
// repos this session's workers used once their branch's PR is merged on GitHub, the
// tree is clean and no worker there is working or blocked. Closes those workers' tabs
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
    const commons = new Set<string>()
    for (const j of Object.values(await jobs($))) {
      if (!(await $.fs.exists(j.cwd))) continue
      const c = await run(['git', '-C', j.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (c) commons.add(c)
    }
    if (commons.size === 0) return done

    let agents: HerdrAgent[] = []
    try {
      agents = (await herdr<{ agents?: HerdrAgent[] }>($, ['agent', 'list'])).agents ?? []
    } catch {}
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
        if (here.some(a => a.agent_status === 'working' || a.agent_status === 'blocked')) continue
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
          try {
            await herdr($, ['tab', 'close', a.tab_id])
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
