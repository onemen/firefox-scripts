// test/unit/installer/makefileGeneratorFlags.test.mjs — regression guard for the
// 2026-09-25 snapshot bug: the Makefile's CONFIG_GENERATOR invocations re-run
// syncGeneratedFiles.mjs, which regenerates the FULL generated set — including
// installer/src/_config.h, the file that bakes the build's MODE/LOCAL identity.
// The #327 `dates` rule invoked the generator with --touch only, so every
// `make dist_win` re-baked _config.h as the prod variant AFTER `config` had
// written the local one — the snapshot installer silently lost CFG_LOCAL,
// pointed its tabs at the GitHub release URLs, and the local-snapshot
// "zero GitHub traffic" contract broke (user-caught, E2E blind spot).
//
// Invariant: EVERY `node $(CONFIG_GENERATOR) …` recipe line in installer/Makefile
// passes the same $(if $(MODE)…) / $(if $(LOCAL)…) passthrough as the others.
// Pattern modeled on installerIcon.test.mjs (Makefile-as-text wiring checks).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const makefile = fs.readFileSync(path.join(REPO_ROOT, 'installer', 'Makefile'), 'utf-8');

/** Every recipe line that invokes the generated-files sync generator. */
function generatorInvocations() {
  return makefile
    .split('\n')
    .filter(line => line.includes('$(CONFIG_GENERATOR)) '))
    .filter(line => line.trim().startsWith('@node ') || line.includes('\t@node '));
}

test('Makefile: every CONFIG_GENERATOR invocation passes the MODE/LOCAL passthrough', () => {
  const invocations = generatorInvocations();
  assert.ok(
    invocations.length >= 2,
    `expected the config + dates generator rules in installer/Makefile, found ${invocations.length} — did the invocation pattern change? Update this test, do not delete it.`
  );
  for (const line of invocations) {
    assert.match(
      line,
      /\$\(if \$\(MODE\),--mode=\$\(MODE\),\)/,
      `generator invocation without the MODE passthrough — it would re-bake _config.h as prod mid-build:\n${line}`
    );
    assert.match(
      line,
      /\$\(if \$\(LOCAL\),--local,\)/,
      `generator invocation without the LOCAL passthrough — a --local snapshot build would lose CFG_LOCAL (the 2026-09-25 regression):\n${line}`
    );
  }
});

test('Makefile: config and dates targets exist and drive their generated headers', () => {
  assert.match(makefile, /^config: \$\(SRC_DIR\)\/_config\.h$/m, 'config target missing');
  assert.match(makefile, /^dates: \$\(SRC_DIR\)\/_builddate\.h$/m, 'dates target missing');
  assert.match(
    makefile,
    /^\$\(SRC_DIR\)\/_config\.h: \.\.\/config\/installer\.conf FORCE$/m,
    '_config.h must depend on FORCE (plus installer.conf) so the binary always bakes the CURRENT mode'
  );
  assert.match(
    makefile,
    /^\$\(SRC_DIR\)\/_builddate\.h: FORCE$/m,
    '_builddate.h must depend on FORCE (idempotent regeneration, issue #322)'
  );
});

test('Makefile: _config.h and _builddate.h rules are byte-identical generators apart from the target', () => {
  // The two rules must stay in lockstep: both regenerate the full set through
  // the same generator with the same flags. Extract each recipe line and
  // compare the flag-bearing tail so a future edit cannot update one and not
  // the other (exactly how the 2026-09-25 regression happened).
  const recipes = {};
  for (const m of makefile.matchAll(
    /^\$\(SRC_DIR\)\/(_config\.h|_builddate\.h): [^\n]*FORCE\n\t@node \$\(subst \\,\/,\$\(CONFIG_GENERATOR\)\) (.+)$/gm
  )) {
    recipes[m[1]] = m[2];
  }
  assert.equal(
    recipes._config_h,
    recipes._builddate_h,
    `the _config.h and _builddate.h generator recipes diverged — they must carry identical MODE/LOCAL passthrough:\n  _config.h:    ${recipes._config_h}\n  _builddate.h: ${recipes._builddate_h}`
  );
});
