# Live Firefox test contract

Read this before installing or reloading an XPI, changing live browser state, or taking the restart branch. Scale assertions to the requested behavior; do not turn a focused regression into a compatibility suite.

## Evidence ladder

Keep each claim at its highest completed level:

1. **Static:** source inspection and syntax checks.
2. **Package:** the exact XPI contains the intended files and metadata.
3. **Protocol:** framing, actor discovery, request correlation, and capability probes succeed.
4. **Install/readiness:** the intended add-on version is active in the target process and feature-specific readiness succeeds.
5. **Behavior:** the actual user-facing or native runtime path produces the expected result.
6. **Restoration:** task-owned state is removed and the shared session matches its baseline.

## Resolve the target before connecting

Target identity comprises the resolved executable; reported product, version, or build identifier when available; detected platform; PID and start time; caller-selected loopback port; profile identity; and a stable browser-instance sentinel.

An explicitly supplied executable overrides discovery. Validate it as the exact file and preserve it through argument arrays. A directory, missing file, substituted binary, channel mismatch, unsafe handoff to a different existing Firefox instance, or locked profile blocks launch. Do not silently add isolation flags, create/select a profile, or choose another channel. Discovery is only a fallback when no executable was supplied.

Record whether Firefox and the listener predated the task and whether this task launched either. Do not launch merely to inspect a supplied path. Connect only to `127.0.0.1` at the caller-selected port.

## Ownership and baseline

- Establish one explicit mutation owner for the Firefox instance. Other tasks remain read-only and use separate sockets, or close their clients and explicitly hand off mutation ownership. If coordination is unavailable or target identity is uncertain, stop before mutation.
- Use one live task-owned socket at a time. Do not share it across tasks or reconnect per evaluation. After invalidation or restart, dispose the old client before the single authorized sequential replacement.
- Capture opaque window/tab order and selection, feature state, listener/process ownership, add-on state, and only the URLs/titles needed as evidence. Choose restoration invariants before mutation.
- Keep task-operation sentinels and live identities, including original method references, in a uniquely named property on a stable browser window. Keep only serializable restoration invariants in the client.
- For browser-managed groups or containers, retain group identity and neighboring anchors. Treat a global native index as diagnostic unless the requested behavior owns it.

## Capability gate

Begin with a small read-only probe using the tested client. Record the root greeting, traits, and actor forms. The supported parent-process path requires:

1. `listProcesses` on the root actor;
2. a parent-process descriptor;
3. `getTarget` on that descriptor;
4. a console actor on the target; and
5. `evaluateJSAsync` on the console actor.

If any part is missing, return `unsupported` with the exact missing capability and detected target identity. Do not guess alternate actors, packets, or privileged globals. Probe every version-sensitive API needed by the planned matrix before mutation.

This gate is the listener preflight and runs before any task operation. Connection refusal/reset, a malformed or missing greeting, or timeout/transport failure in a mandatory capability marks the listener unhealthy. Dispose that client. With prior restart authorization, a complete baseline, and exclusive ownership, take the restart checkpoint immediately instead of opening a replacement socket to the same listener. Without those prerequisites, stop before the task call. Rerun the full gate once on the replacement instance; another unhealthy result stops without a task operation or second restart. Treat an explicit unsupported-capability response as incompatibility, not listener failure.

## Same-process XPI install and readiness

Validate the exact XPI path, contents, expected add-on ID, and version first. Through the same parent-process connection, import `AddonManager`, construct an `nsIFile`, pass the native path serialized with `JSON.stringify(xpiPath)` to `initWithPath()`, and call `AddonManager.getInstallForFile(file)`. Capture candidate state/error before and after `install.install()`, then query the expected add-on ID, version, active/disabled flags, and restart requirement. Observed numeric states are run evidence, not cross-version constants.

Start asynchronous work behind the browser-window sentinel. Poll a small serialized status object with bounded `evaluateJson` or `pollJson` calls; raw RDP values may be protocol grips. Readiness is feature-owned: assert the predicate for every affected pre-existing window or frame. A navigation `tabNavigated` event with `state: "stop"` proves navigation completion, not application or network idle.

A timeout invalidates the socket but does not cancel dispatched Firefox-side work and never authorizes replay. Dispose the invalidated client, then create one authorized sequential replacement only to query the task-owned sentinel or authoritative add-on state once. Resume without replay if the operation succeeded. One retry is safe only when the operation is absent, conclusively failed without effects, or fully restored; otherwise stop and report the last state.

If an active same-version install still serves old chrome/resource bytes, do not bump the version or repeat installation as a cache workaround. Take the restart branch only with separate authorization; otherwise label the cache-sensitive behavior unverified.

## Real-path regression design

Test the earliest native path that reproduces the failure. Until the first divergent call or error is observed, the cause is **unlocalized**. A passing downstream shortcut narrows the boundary but is not the acceptance test.

For a native cross-window tab-drag regression:

1. Create one uniquely identifiable disposable tab.
2. Trace the native drag/drop handler with temporary in-memory hooks.
3. Perform drag-out, then return the replacement tab created by adoption.
4. Assert destination group identity, selection, contiguous native `_tPos` order, and no thrown errors or duplicate tabs.
5. Remove only the disposable tab/window and tracing.

Direct `gBrowser.adoptTab()` bypasses the native drop handler and cannot prove this regression.

## Restart checkpoint

Restart only for a pre-authorized unhealthy listener preflight or after restartless operation is shown insufficient and the user separately approves it. Capture the executable/profile, original instance sentinel, PID/process tree, listener, serializable session invariants, relevant add-on state, and task-owned resources. Require every other known task to release mutation ownership and close its client; uncertain release blocks restart.

Request an ordinary quit through the sole authorized control path. Socket closure is expected: dispose the old client and wait to the diagnostic deadline without killing a shared or pre-existing process. Relaunch the same executable and profile without adding isolation flags. Detect the replacement PID, expose the caller-approved loopback listener, create one new client, rediscover capabilities, and capture a new sentinel and actor set. Old actors, sentinels, sockets, and snapshots are invalid.

Wait for feature readiness and authoritative session restoration, repeat the intended real-path behavior, then compare the captured invariants. Recreate a task-owned captured page once only if absent after restoration completes; do not reorder unrelated tabs. Record what was restored and every remaining difference.

## Cleanup matrix

| Initial ownership | Required end state |
|---|---|
| Firefox and listener pre-existed | Close only this task's client; leave both running. |
| Task started listener on pre-existing Firefox | Close the client; leave Firefox running and report that the listener persists until Firefox exits. |
| Task launched dedicated Firefox | Close the client, terminate only the recorded owned process tree, and verify its listener stopped. |

In `finally`, restore task-owned globals, wrapped methods, preferences, tabs/groups, window selection/focus, and feature layout. Do not uninstall an add-on the user asked to install or update, and never clean up another task's resources.

## Result contract

Report the resolved executable, reported product and version/build, and detected platform; PID/start time; opaque/redacted profile identity and instance sentinel; port and ownership; capability path; XPI identity; install state/error; per-window readiness; actual-path assertions; restoration comparison; client closure; and any listener/process left running.

Name the highest evidence level reached. Label **static inference**, **live observation**, and **unverified compatibility** separately. A build or package check does not prove live Firefox behavior; a completed install does not prove readiness or the real path; blocked or skipped checks remain unverified.
