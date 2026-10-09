// test/unit/tools/stateBranch.test.mjs — the durable state-branch contract
// (#462).
//
// The watchdog's baseline and the E2E validated-versions record used to live
// only in `actions/cache` entries. GitHub evicted both on 2026-10-06 (the repo
// crossed the 10 GB cap), and the consequences were exactly the ones the
// watchdog is supposed to prevent: every browser rendered `⏳ first run`, the
// E2E-validated column dropped to `⏳ none` while the meta issue's own rolling
// comment still carried the versions, the nightly re-paid ~900 MB of hashing,
// and the prod publish pre-flight failed closed because an evicted record is
// indistinguishable from "never validated".
//
// Both files now live on an orphan branch, `watchdog-state`, and this file is
// the contract for that home. It is deliberately end-to-end: the fixture below
// builds a real bare remote, seeds it, clones it shallow (the CI shape) and runs
// the tool's own `push`/`fetch` against it. A stub would prove the argument list
// and nothing else — the things that can actually break are the git plumbing
// (an orphan's first commit, a tree that must keep the OTHER writer's file, a
// shallow clone's push) and the file's own mtime. The last tests pin the wiring
// in the workflows, because "the state went back into an evictable cache" is the
// regression this issue exists to prevent.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI = path.join(REPO_ROOT, 'tools', 'ci', 'state-branch.mjs');
const {STATE_BRANCH, STATE_FILES, resolveTargets, fetchState, pushState} = await import(
  pathToFileURL(CLI).href
);

/**
 * The environment every git call here runs with. `GIT_DIR` and friends are
 * dropped: this repo's own pre-push hook exports them to its children, and a
 * fixture (or the tool) that honoured them would operate on the checkout's
 * repository instead of the temp one — which is exactly how this file first
 * failed, under `pnpm test` inside the hook.
 */
const GIT_REDIRECTING_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
];

/** @param {Record<string, string | undefined>} [extra] */
function hermeticEnv(extra = {}) {
  const env = {...process.env, GIT_TERMINAL_PROMPT: '0', ...extra};
  for (const key of GIT_REDIRECTING_KEYS) delete env[key];
  return env;
}

/** Run git, returning stdout as text. */
function git(cwd, args) {
  return execFileSync('git', args, {cwd, env: hermeticEnv(), stdio: 'pipe'}).toString('utf8');
}

/** Run git, returning {status, stdout, stderr} instead of throwing. */
function gitTry(cwd, args) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      env: hermeticEnv(),
      stdio: 'pipe',
    }).toString('utf8');
    return {status: 0, stdout, stderr: ''};
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

/** Run the CLI expecting a non-zero exit, returning {status, stderr}. */
function cliFails(cwd, args, env) {
  try {
    execFileSync('node', [CLI, ...args], {cwd, env: hermeticEnv(env), stdio: 'pipe'});
  } catch (err) {
    return {status: err.status, stderr: String(err.stderr ?? '')};
  }
  throw new Error(`state-branch ${args.join(' ')} unexpectedly succeeded`);
}

/**
 * A bare remote seeded with one commit on `main`, plus a SHALLOW clone of it —
 * the shape an `actions/checkout` job is in. The state dirs point outside the
 * clone so {@link stateFilesTouched} can prove the plumbing never touched the
 * checked-out tree.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-state-branch-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  git(root, ['init', '--bare', '-q', remote]);
  git(root, ['init', '-q', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
  git(seed, ['add', '.']);
  git(seed, ['-c', 'user.name=seed', '-c', 'user.email=seed@test', 'commit', '-qm', 'init']);
  git(seed, ['remote', 'add', 'origin', pathToFileURL(remote).href]);
  git(seed, ['push', '-q', 'origin', 'main']);
  git(root, ['clone', '-q', '--depth=1', '-b', 'main', pathToFileURL(remote).href, clone]);
  const stateDir = path.join(root, 'state');
  const validatedDir = path.join(root, 'state-validated');
  return {
    root,
    remote,
    clone,
    stateDir,
    validatedDir,
    env: {
      BASELINE_DIR: stateDir,
      VALIDATED_DIR: validatedDir,
      GITHUB_RUN_ID: '424242',
    },
  };
}

/** Write a state file the way its writer tool would. */
function writeState(fx, name, body) {
  const dir = name === 'baseline.json' ? fx.stateDir : fx.validatedDir;
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, name), body);
}

/** The blob names on the state branch (empty when the branch does not exist). */
function branchTree(fx) {
  const res = gitTry(fx.remote, ['ls-tree', '-r', '--name-only', STATE_BRANCH]);
  return res.status === 0 ? res.stdout.split('\n').filter(Boolean).sort() : [];
}

/**
 * Everything the state plumbing changed in the clone's working tree, index and
 * HEAD — which must be nothing: the tool writes a commit straight to the branch
 * with plumbing, so a job's checkout is undisturbed.
 */
function stateFilesTouched(fx) {
  return {
    status: git(fx.clone, ['status', '--porcelain']).trim(),
    head: git(fx.clone, ['rev-parse', 'HEAD']).trim(),
  };
}

test('the branch name and the file set are the durable-state contract', () => {
  assert.equal(STATE_BRANCH, 'watchdog-state');
  assert.deepEqual(Object.keys(STATE_FILES), ['baseline.json', 'validated.json']);
});

test('resolveTargets: the env dirs win, the cwd is the fallback', () => {
  const inClone = resolveTargets(['baseline.json'], {}, '/checkout');
  assert.equal(
    inClone[0].file,
    path.join('/checkout', '.watchdog', 'baseline.json'),
    'a caller that sets no dir gets the checkout-relative default'
  );
  const fromEnv = resolveTargets(['baseline.json', 'validated.json'], {
    BASELINE_DIR: '/b',
    VALIDATED_DIR: '/v',
  });
  // The env contract is the same one the two files' own tools already honor, so
  // no caller has to repeat a path that the workflow already exports.
  assert.deepEqual(
    fromEnv.map(t => t.file),
    [path.join('/b', 'baseline.json'), path.join('/v', 'validated.json')]
  );
  assert.throws(() => resolveTargets(['nope.json']), /unknown state file/);
});

test('fetch on a branch that does not exist yet is a silent no-op', async () => {
  const fx = fixture();
  try {
    const logs = [];
    const out = await fetchState(['baseline.json', 'validated.json'], {
      cwd: fx.clone,
      env: {...process.env, ...fx.env},
      log: line => logs.push(line),
    });
    assert.deepEqual(out, [
      {name: 'baseline.json', present: false},
      {name: 'validated.json', present: false},
    ]);
    // The first run must not fabricate an empty state file: an empty baseline
    // reads as "every browser is new", which is the failure mode, not a
    // neutral starting point.
    assert.equal(
      fs.existsSync(path.join(fx.stateDir, 'baseline.json')),
      false,
      'absent state must stay absent'
    );
    assert.match(logs.join('\n'), /first run/);
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('push creates an orphan branch carrying exactly the named file', async () => {
  const fx = fixture();
  try {
    writeState(fx, 'baseline.json', '{"firefox":{"version":"157.0.1"}}\n');
    await pushState(['baseline.json'], {cwd: fx.clone, env: {...process.env, ...fx.env}});

    assert.deepEqual(branchTree(fx), ['baseline.json']);
    // ORPHAN, like gh-pages (ADR 0031): the branch is artifact-only and must
    // never inherit main's tree — a state branch that suddenly carries the whole
    // repo is not what the fetch/read side expects to filter.
    const parents = git(fx.remote, ['log', '--format=%P', STATE_BRANCH]).trim();
    assert.equal(parents, '', 'the first state commit must have no parent');
    assert.equal(git(fx.remote, ['rev-list', '--count', STATE_BRANCH]).trim(), '1');
    // ...and it must not be reachable from main.
    assert.notEqual(
      gitTry(fx.remote, ['merge-base', '--is-ancestor', STATE_BRANCH, 'main']).status,
      0,
      'the state branch must stay off main'
    );
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('a push carries the other writer’s file forward, never drops it', async () => {
  const fx = fixture();
  try {
    // Two writers own one file each: the watchdog owns baseline.json, E2E's
    // record-validation owns validated.json. Each builds its tree FROM the
    // fetched tip, so the second push must not orphan the first file — the
    // regression here would be a state branch silently losing the baseline
    // every time a night validated browser versions.
    writeState(fx, 'baseline.json', '{"firefox":{"version":"157.0.1"}}\n');
    await pushState(['baseline.json'], {cwd: fx.clone, env: {...process.env, ...fx.env}});
    writeState(fx, 'validated.json', '{"browsers":{"firefox":{"version":"157.0.1"}}}\n');
    await pushState(['validated.json'], {cwd: fx.clone, env: {...process.env, ...fx.env}});

    assert.deepEqual(branchTree(fx), ['baseline.json', 'validated.json']);
    assert.equal(
      git(fx.remote, ['show', `${STATE_BRANCH}:baseline.json`]).trim(),
      '{"firefox":{"version":"157.0.1"}}'
    );
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('pushing unchanged state adds no commit', async () => {
  const fx = fixture();
  try {
    writeState(fx, 'baseline.json', '{"firefox":{"version":"157.0.1"}}\n');
    const env = {...process.env, ...fx.env};
    await pushState(['baseline.json'], {cwd: fx.clone, env});
    const before = git(fx.remote, ['rev-list', '--count', STATE_BRANCH]).trim();

    const logs = [];
    const out = await pushState(['baseline.json'], {cwd: fx.clone, env, log: l => logs.push(l)});
    assert.deepEqual(out, [{name: 'baseline.json', commit: null}]);
    assert.equal(git(fx.remote, ['rev-list', '--count', STATE_BRANCH]).trim(), before);
    assert.match(logs.join('\n'), /unchanged — nothing to push/);
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('fetch materializes the bytes verbatim and dates the file from the commit', async () => {
  const fx = fixture();
  try {
    // A body that would not survive a text-mode round trip: CRLF, a missing
    // trailing newline, non-ASCII. The state files are JSON, but the fetch must
    // not be the thing that decides that.
    const body = '{"note":"caf\u00e9","crlf":"a\\r\\nb"}';
    writeState(fx, 'baseline.json', body);
    const env = {...process.env, ...fx.env};
    await pushState(['baseline.json'], {cwd: fx.clone, env});

    // A COLD clone with no cache of any kind — the #462 reproduction: the branch
    // alone has to carry the state.
    const cold = path.join(fx.root, 'cold');
    git(fx.root, ['clone', '-q', '--depth=1', '-b', 'main', pathToFileURL(fx.remote).href, cold]);
    const coldBaseline = path.join(fx.root, 'cold-state', 'baseline.json');
    const out = await fetchState(['baseline.json'], {
      cwd: cold,
      env: {...process.env, BASELINE_DIR: path.dirname(coldBaseline)},
    });
    assert.deepEqual(out, [{name: 'baseline.json', present: true}]);
    assert.equal(fs.readFileSync(coldBaseline, 'utf8'), body);

    // The mtime is the commit's, not "now": the watchdog reports how old its
    // state is, and a fetch that stamped every file with the checkout's clock
    // would report "0 s ago" forever — hiding a state that stopped updating.
    const commitSecs = Number(
      git(fx.remote, ['log', '-1', '--format=%ct', STATE_BRANCH, '--', 'baseline.json']).trim()
    );
    const mtimeSecs = fs.statSync(coldBaseline).mtimeMs / 1000;
    assert.ok(
      Math.abs(mtimeSecs - commitSecs) < 2,
      `file mtime ${mtimeSecs} must come from the commit date ${commitSecs}`
    );
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('a file the branch does not carry is left absent, not emptied', async () => {
  const fx = fixture();
  try {
    const env = {...process.env, ...fx.env};
    writeState(fx, 'baseline.json', '{"firefox":{"version":"157.0.1"}}\n');
    await pushState(['baseline.json'], {cwd: fx.clone, env});

    const logs = [];
    const out = await fetchState(['baseline.json', 'validated.json'], {
      cwd: fx.clone,
      env,
      log: l => logs.push(l),
    });
    assert.deepEqual(out, [
      {name: 'baseline.json', present: true},
      {name: 'validated.json', present: false},
    ]);
    // The publish pre-flight treats an absent record as "not validated" and
    // fails closed (ADR 0039). A zero-byte file would instead parse as an empty
    // record — a silently passing gate — so absence has to stay absence.
    assert.equal(fs.existsSync(path.join(fx.validatedDir, 'validated.json')), false);
    assert.match(logs.join('\n'), /carries no validated\.json/);
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('a stale writer still converges: the push is built on the fetched tip', async () => {
  const fx = fixture();
  try {
    const env = {...process.env, ...fx.env};
    writeState(fx, 'baseline.json', '{"firefox":{"version":"157.0.1"}}\n');
    await pushState(['baseline.json'], {cwd: fx.clone, env});

    // A second writer that read the state BEFORE the first push landed (its own
    // clone, its own dir) — the concurrent case the nightly and the E2E record
    // job are in whenever they overlap.
    const second = path.join(fx.root, 'second');
    git(fx.root, ['clone', '-q', '--depth=1', '-b', 'main', pathToFileURL(fx.remote).href, second]);
    const secondBaseline = path.join(fx.root, 'second-state', 'baseline.json');
    const secondEnv = {
      ...process.env,
      BASELINE_DIR: path.dirname(secondBaseline),
      VALIDATED_DIR: fx.validatedDir,
    };
    fs.mkdirSync(path.dirname(secondBaseline), {recursive: true});
    fs.writeFileSync(secondBaseline, '{"firefox":{"version":"158.0b1"}}\n');
    await pushState(['baseline.json'], {cwd: second, env: secondEnv});

    // The later write wins, the other writer's file survives, and the history
    // stays linear (a fast-forward per writer, never a force).
    assert.equal(
      git(fx.remote, ['show', `${STATE_BRANCH}:baseline.json`]).trim(),
      '{"firefox":{"version":"158.0b1"}}'
    );
    assert.deepEqual(branchTree(fx), ['baseline.json']);
    assert.equal(git(fx.remote, ['rev-list', '--count', STATE_BRANCH]).trim(), '2');
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('the plumbing never touches the checkout, the index or HEAD', async () => {
  const fx = fixture();
  try {
    const env = {...process.env, ...fx.env};
    const before = stateFilesTouched(fx);
    writeState(fx, 'baseline.json', '{"firefox":{"version":"157.0.1"}}\n');
    await pushState(['baseline.json'], {cwd: fx.clone, env});
    await fetchState(['baseline.json'], {cwd: fx.clone, env});
    assert.deepEqual(stateFilesTouched(fx), before);
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('a GIT_DIR in the environment cannot retarget the push', async () => {
  const fx = fixture();
  try {
    // Git hooks export GIT_DIR (and friends) to their children, so this file's
    // first run under the repo's own pre-push hook pushed into the checkout
    // instead of the fixture. A state push that quietly commits another
    // repository's tree is the worst failure this tool can have, so the cwd —
    // not the environment — decides which repo is written.
    const decoy = path.join(fx.root, 'decoy');
    git(fx.root, ['init', '-q', '-b', 'main', decoy]);
    fs.writeFileSync(path.join(decoy, 'README.md'), '# decoy\n');
    git(decoy, ['add', '.']);
    git(decoy, ['-c', 'user.name=d', '-c', 'user.email=d@test', 'commit', '-qm', 'decoy']);

    writeState(fx, 'baseline.json', '{"firefox":{"version":"157.0.1"}}\n');
    await pushState(['baseline.json'], {
      cwd: fx.clone,
      env: {
        ...process.env,
        ...fx.env,
        GIT_DIR: path.join(decoy, '.git'),
        GIT_WORK_TREE: decoy,
      },
    });

    assert.deepEqual(branchTree(fx), ['baseline.json'], 'the cwd repo got the state');
    assert.notEqual(
      gitTry(decoy, ['rev-parse', '--verify', '--quiet', STATE_BRANCH]).status,
      0,
      'the repo named by GIT_DIR must not be touched'
    );
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('push refuses a file the caller never wrote', async () => {
  const fx = fixture();
  try {
    // The E2E record job only ever writes validated.json; if it could push
    // baseline.json it would publish a stale baseline over the watchdog's fresh
    // one — a state write has to be about a file the caller produced.
    await assert.rejects(
      pushState(['baseline.json'], {cwd: fx.clone, env: {...process.env, ...fx.env}}),
      /refusing to push missing state file/
    );
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('the CLI takes names from the caller, and refuses to guess', () => {
  const fx = fixture();
  try {
    // `push` with no name is the dangerous default (push whatever happens to be
    // lying in the checkout), so it is an error with the usage text.
    const bare = cliFails(fx.clone, ['push'], fx.env);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /at least one file name/);
    assert.match(bare.stderr, /baseline\.json/);
    // An unknown name must fail rather than silently push nothing.
    assert.match(cliFails(fx.clone, ['push', 'bogus.json'], fx.env).stderr, /unknown state file/);
    assert.match(cliFails(fx.clone, ['fetch', 'bogus.json'], fx.env).stderr, /unknown state file/);
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});

test('a fetch failure is never mistaken for absent state', async () => {
  const fx = fixture();
  try {
    // A remote that cannot be reached is a hard error: the whole #462 bug was a
    // storage failure rendering as "no state", so the tool must not widen that.
    git(fx.clone, ['remote', 'set-url', 'origin', pathToFileURL(path.join(fx.root, 'gone')).href]);
    await assert.rejects(
      fetchState(['baseline.json'], {cwd: fx.clone, env: {...process.env, ...fx.env}}),
      /git fetch/
    );
  } finally {
    fs.rmSync(fx.root, {recursive: true, force: true});
  }
});
