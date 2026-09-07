// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analysisComplete,
  enginesReported,
  maliciousEngines,
  scanVirusTotal,
  vtFailThreshold,
  vtVerdict,
  vtVetoEngines,
} from '../../../tools/scan-vt.mjs';

test('vtVerdict: clean when no malicious engines', () => {
  assert.equal(vtVerdict({malicious: 0, suspicious: 2, harmless: 60}, 3), 'clean');
  assert.equal(vtVerdict({}, 3), 'clean');
  assert.equal(vtVerdict(undefined, 3), 'clean');
});

test('enginesReported: counts every engine category, zero for empty', () => {
  assert.equal(enginesReported({}), 0);
  assert.equal(enginesReported(undefined), 0);
  assert.equal(
    enginesReported({
      malicious: 2,
      suspicious: 0,
      harmless: 60,
      undetected: 5,
      timeout: 3,
      failure: 1,
    }),
    71
  );
});

test('analysisComplete: only a finished analysis with engine results counts', () => {
  assert.equal(analysisComplete('completed', {malicious: 0, harmless: 60}), true);
  assert.equal(analysisComplete('completed', {malicious: 2}), true);
  // The CI bug: a timed-out poll left status 'queued' with empty stats,
  // which used to be reported as "clean".
  assert.equal(analysisComplete('queued', {}), false);
  assert.equal(analysisComplete('queued', {malicious: 2}), false);
  assert.equal(analysisComplete('completed', {}), false);
  assert.equal(analysisComplete('completed', undefined), false);
  assert.equal(analysisComplete(undefined, {}), false);
});

test('vtVerdict: warn on a few malicious engines (below threshold)', () => {
  assert.equal(vtVerdict({malicious: 1}, 3), 'warn');
  assert.equal(vtVerdict({malicious: 2}, 3), 'warn');
});

test('vtVerdict: fail at/above the threshold', () => {
  assert.equal(vtVerdict({malicious: 3}, 3), 'fail');
  assert.equal(vtVerdict({malicious: 9}, 3), 'fail');
});

test('vtVerdict: a veto engine (Microsoft) fails below the threshold', () => {
  // The CI-built exe: Microsoft + Bkav flag, 2 < threshold 3 — must still fail.
  const engines = {
    Microsoft: {category: 'malicious', result: 'Trojan:Win32/Wacatac.C!ml'},
    Bkav: {category: 'malicious', result: 'W32.Malware.7F00676A'},
  };
  assert.equal(vtVerdict({malicious: 2}, 3, engines), 'fail');
  assert.equal(vtVerdict({malicious: 1}, 3, {Microsoft: {category: 'malicious'}}), 'fail');
});

test('vtVerdict: non-veto engines keep warn semantics below the threshold', () => {
  assert.equal(
    vtVerdict({malicious: 2}, 3, {Bkav: {category: 'malicious'}, Elastic: {category: 'malicious'}}),
    'warn'
  );
  assert.equal(vtVerdict({malicious: 1}, 3, {Bkav: {category: 'malicious'}}), 'warn');
  // Microsoft present but NOT malicious must not veto.
  assert.equal(vtVerdict({malicious: 1}, 3, {Microsoft: {category: 'undetected'}}), 'warn');
});

test('vtVerdict: custom veto list is honored', () => {
  assert.equal(vtVerdict({malicious: 1}, 3, {Bkav: {category: 'malicious'}}, ['Bkav']), 'fail');
  assert.equal(vtVerdict({malicious: 1}, 3, {Bkav: {category: 'malicious'}}, []), 'warn');
});

test('maliciousEngines: lists only engines whose category is malicious', () => {
  assert.deepEqual(
    maliciousEngines({
      Microsoft: {category: 'malicious'},
      Bkav: {category: 'malicious'},
      Elastic: {category: 'undetected'},
      Ikarus: {category: 'failure'},
    }),
    ['Microsoft', 'Bkav']
  );
  assert.deepEqual(maliciousEngines(undefined), []);
  assert.deepEqual(maliciousEngines({}), []);
});

test('vtVerdict: threshold is per-call and not global', () => {
  assert.equal(vtVerdict({malicious: 1}, 1), 'fail');
  assert.equal(vtVerdict({malicious: 1}, 5), 'warn');
});

test('vtFailThreshold: defaults to 3, honors VT_FAIL_THRESHOLD', () => {
  const before = process.env.VT_FAIL_THRESHOLD;
  try {
    delete process.env.VT_FAIL_THRESHOLD;
    assert.equal(vtFailThreshold(), 3);
    process.env.VT_FAIL_THRESHOLD = '1';
    assert.equal(vtFailThreshold(), 1);
    process.env.VT_FAIL_THRESHOLD = '0'; // invalid ⇒ default
    assert.equal(vtFailThreshold(), 3);
    process.env.VT_FAIL_THRESHOLD = 'bogus'; // invalid ⇒ default
    assert.equal(vtFailThreshold(), 3);
  } finally {
    if (before === undefined) delete process.env.VT_FAIL_THRESHOLD;
    else process.env.VT_FAIL_THRESHOLD = before;
  }
});

test('scanVirusTotal: VT_VETO_ENGINES env reaches the verdict (regression: veto was hardcoded)', async () => {
  // The env veto must change the gate. Mock the VT API so the file is "known":
  // POST /files → 409 (duplicate), then GET /files/<sha> twice — once for the
  // last_analysis_stats, once for the per-engine results (Bkav malicious at
  // count 1, under threshold 3 — only a Bkav veto can make this 'fail').
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-vt-veto-'));
  const file = path.join(dir, 'sample.bin');
  fs.writeFileSync(file, 'vt-veto-regression');
  const realFetch = globalThis.fetch;
  const key = process.env.VT_API_KEY;
  const veto = process.env.VT_VETO_ENGINES;
  try {
    process.env.VT_API_KEY = 'test-key';
    process.env.VT_VETO_ENGINES = 'Bkav';
    let fileGets = 0;
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).endsWith('/files') && (opts.method ?? 'GET') === 'POST') {
        return {ok: false, status: 409, json: async () => ({})};
      }
      fileGets += 1;
      const attrs =
        fileGets === 1 ?
          {last_analysis_stats: {malicious: 1, suspicious: 0, harmless: 0, undetected: 60}}
        : {
            last_analysis_results: {
              Bkav: {category: 'malicious', result: 'W32.Malware.X'},
              Microsoft: {category: 'undetected'},
            },
          };
      return {ok: true, status: 200, json: async () => ({data: {attributes: attrs}})};
    };
    const {results} = await scanVirusTotal([file]);
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'fail', 'Bkav veto from VT_VETO_ENGINES must fail the gate');
    assert.deepEqual(results[0].flags, ['Bkav']);
  } finally {
    globalThis.fetch = realFetch;
    if (key === undefined) delete process.env.VT_API_KEY;
    else process.env.VT_API_KEY = key;
    if (veto === undefined) delete process.env.VT_VETO_ENGINES;
    else process.env.VT_VETO_ENGINES = veto;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('vtVetoEngines: defaults to Microsoft, honors VT_VETO_ENGINES', () => {
  const before = process.env.VT_VETO_ENGINES;
  try {
    delete process.env.VT_VETO_ENGINES;
    assert.deepEqual(vtVetoEngines(), ['Microsoft']);
    process.env.VT_VETO_ENGINES = 'Bkav, Elastic';
    assert.deepEqual(vtVetoEngines(), ['Bkav', 'Elastic']);
    process.env.VT_VETO_ENGINES = ','; // empty ⇒ default
    assert.deepEqual(vtVetoEngines(), ['Microsoft']);
  } finally {
    if (before === undefined) delete process.env.VT_VETO_ENGINES;
    else process.env.VT_VETO_ENGINES = before;
  }
});
