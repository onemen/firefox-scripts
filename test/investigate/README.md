# Discussion #101 investigation — legacy chrome lifecycle

Archive of the thread that drove this work:
[onemen/firefox-scripts discussion #101 — "This is interesting"](https://github.com/onemen/firefox-scripts/discussions/101).
Everything from the thread is preserved **verbatim** in the sections below so the record
survives the discussion being closed. Live thread status: the empirical reply was posted on
2026-09-05 and the thread is expected to be closed afterwards.

## Background

On 2026-09-01 the discussion posted an FYI about a variant of `core/chrome/utils/BootstrapLoader.js`
that writes a **UUID-named** temp manifest and deletes it at exit via `deleteTemporaryFileOnExit()`.
The observation: _"it does not blow up immediately after clear cache restart … The manifest did
get deleted though. So, idk just FYI."_ The author floated four guesses: PR #26, issue #156,
the manifest path, and "addon startup late".

This branch (`postv1/manifest-lifecycle-e2e`, deferred post-v1) holds the resulting work: an
empirical investigation (this directory) plus a formal E2E regression test and a loader change.

## Findings (TL;DR)

- **Registrations are re-derived per session.** The chrome registry does not persist dynamic
  manifest registrations across sessions; every startup re-registers from what gets
  `autoRegister`ed then. Deleting the temp manifest at exit therefore cannot break the next
  session's chrome, and clearing the startup cache is irrelevant (it holds compiled scripts,
  not registrations).
- **Verified empirically** on Firefox 155.0.1 (real legacy bootstrap extension, probe of
  `chrome://testext/content/test.html` from autoconfig at 1 s granularity): chrome comes live
  ~1.2–1.4 s after start in **every** session — fresh profile, plain restart, cache-cleared
  restart — for both the shipped loader and the discussion variant.
- **"Addon startup late" is ruled out.** Forcing registration 30 s past startup, all variants
  recovered within ~1–6 s of the late registration: `autoRegister` registers chrome inline
  whenever it runs, so the loader never depends on a startup re-scan window.
- **The variant's real weakness is crash litter.** `deleteTemporaryFileOnExit()` only fires on
  clean shutdown; killing the browser leaves one `chrome.manifest.<uuid>` per kill in
  `browser-extension-data/<id>/` (reproduced). The shipped loader's fixed name + manual removal
  avoids that (its own truncate-then-remove can still leave a 0-byte `chrome.manifest` if killed
  between the two steps — hence the startup sweep).
- **Repo follow-ups:** startup sweep in `BootstrapLoader.js` + the E2E regression test, both on
  this branch; recommended extra tests recorded on issue #30; the sweep task recorded on the
  issue #38 umbrella.

## Artifacts

| Artifact                                                                       | Path                                                       | Status                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------- |
| E2E regression — shipped loader × 3 sessions + seeded litter sweep             | `test/e2e/core/manifest-lifecycle-e2e.mjs`                 | committed; 13/13 green on Firefox 155.0.1 |
| Stale-manifest startup sweep                                                   | `core/chrome/utils/BootstrapLoader.js`                     | committed on this branch                  |
| Investigation harness — 4 loader variants, sessions, `--delay` race, `--crash` | `test/investigate/manifest-lifecycle.mjs`                  | committed here                            |
| Local draft of the posted reply                                                | `discussion101.draft.local.md` (gitignored, worktree root) | mirrors live comment 18301884             |

## Running the harness

```
node test/investigate/manifest-lifecycle.mjs [--variant=repo|discussion|discussion+cfnc|uuid-manual] [--all] [--sessions=N] [--delay=MS] [--crash] [--keep-profile]
```

- default variant is `repo` (control); `--all` runs the full 4-variant matrix
- `--delay=30000` registers the extension's chrome 30 s past startup (the "addon startup late" race probe)
- `--crash` kills session 2 instead of closing cleanly and lists `browser-extension-data` afterwards
- set `FXS_KEEP_PROFILES=1` to keep profiles for post-mortem; the harness seeds the profile from a
  dev snapshot and restores the GreD probe afterwards (env vars at the top of the file configure
  the Firefox binary / snapshot)

The E2E regression test: `pnpm test:e2e:legacy` (needs a browser + snapshot, see
`test/e2e/core/manifest-lifecycle-e2e.mjs`).

## Thread timeline

| When (UTC)           | Author            | What                                                    |
| -------------------- | ----------------- | ------------------------------------------------------- |
| 2026-09-01T13:35:22Z | discussion author | Original FYI + variant loader (verbatim below)          |
| 2026-09-02T18:12:21Z | onemen            | "I will look into it"                                   |
| 2026-09-05T08:41:09Z | onemen            | Posted reply — empirical investigation (verbatim below) |

## Verbatim — original post (discussion body)

@onemen
It's a loader use deleteTemporaryFileOnExit() but it does not blow up immediately after clear catch restart. An unholy byproduct of AI usage.
My be is https://github.com/onemen/firefox-scripts/pull/26, may be is 156, may be is path to manifest, may be is because addon startup late. The manifest did get deleted though. So, idk just FYI.

```js
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Services = globalThis.Services;

ChromeUtils.defineESModuleGetters(this, {
  Blocklist: "resource://gre/modules/Blocklist.sys.mjs",
  ConsoleAPI: "resource://gre/modules/Console.sys.mjs",
  InstallRDF: "chrome://userchromejs/content/RDFManifestConverter.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

Services.obs.addObserver((doc) => {
  if (
    doc.location.protocol + doc.location.pathname === "about:addons" ||
    doc.location.protocol + doc.location.pathname ===
      "chrome:/content/extensions/aboutaddons.html"
  ) {
    const win = doc.defaultView;
    let handleEvent_orig =
      win.customElements.get("addon-card").prototype.handleEvent;
    win.customElements.get("addon-card").prototype.handleEvent = function (e) {
      if (
        e.type === "click" &&
        e.target.getAttribute("action") === "preferences" &&
        this.addon.__AddonInternal__.optionsType ==
          1 /*AddonManager.OPTIONS_TYPE_DIALOG*/ &&
        !!this.addon.optionsURL
      ) {
        var windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          var win2 = windows.getNext();
          if (win2.closed) {
            continue;
          }
          if (win2.document.documentURI == this.addon.optionsURL) {
            win2.focus();
            return;
          }
        }
        var features = "chrome,titlebar,toolbar,centerscreen";
        win.docShell.rootTreeItem.domWindow.openDialog(
          this.addon.optionsURL,
          this.addon.id,
          features,
        );
      } else {
        handleEvent_orig.apply(this, arguments);
      }
    };
    let update_orig = win.customElements.get("addon-options").prototype.update;
    win.customElements.get("addon-options").prototype.update = function (
      card,
      addon,
    ) {
      update_orig.apply(this, arguments);
      if (
        addon.__AddonInternal__?.optionsType ==
          1 /*AddonManager.OPTIONS_TYPE_DIALOG*/ &&
        !!addon.optionsURL
      )
        this.querySelector(
          'panel-item[data-l10n-id="preferences-addon-button"]',
        ).hidden = false;
    };
  }
}, "chrome-document-loaded");

const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs",
);
const { XPIDatabase, AddonInternal } = ChromeUtils.importESModule(
  "resource://gre/modules/addons/XPIDatabase.sys.mjs",
);
const { XPIExports } = ChromeUtils.importESModule(
  "resource://gre/modules/addons/XPIExports.sys.mjs",
);

XPIDatabase.isDisabledLegacy = () => false;

var orig_verifyBundleSignedState = XPIExports.verifyBundleSignedState;
XPIExports.verifyBundleSignedState = async (aBundle, aAddon) => {
  if (
    (!aAddon.isWebExtension && aAddon.type === "extension") ||
    aAddon.id.includes("_N_SIGN_")
  )
    return { signedState: undefined, signedTypes: [] };
  return orig_verifyBundleSignedState(aBundle, aAddon);
};

ChromeUtils.defineLazyGetter(this, "BOOTSTRAP_REASONS", () => {
  const { XPIProvider } = ChromeUtils.importESModule(
    "resource://gre/modules/addons/XPIProvider.sys.mjs",
  );
  return XPIProvider.BOOTSTRAP_REASONS;
});

const { Log } = ChromeUtils.importESModule(
  "resource://gre/modules/Log.sys.mjs",
);
var logger = Log.repository.getLogger("addons.bootstrap");

/**
 * Valid IDs fit this pattern.
 */
var gIDTest =
  /^(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[a-z0-9-\._]*\@[a-z0-9-\._]+)$/i;

// Properties that exist in the install manifest
const PROP_METADATA = [
  "id",
  "version",
  "type",
  "internalName",
  "updateURL",
  "optionsURL",
  "optionsType",
  "aboutURL",
  "iconURL",
];
const PROP_LOCALE_SINGLE = ["name", "description", "creator", "homepageURL"];
const PROP_LOCALE_MULTI = ["developers", "translators", "contributors"];

// Map new string type identifiers to old style nsIUpdateItem types.
// Retired values:
// 32 = multipackage xpi file
// 8 = locale
// 256 = apiextension
// 128 = experiment
// theme = 4
const TYPES = {
  extension: 2,
  dictionary: 64,
};

const COMPATIBLE_BY_DEFAULT_TYPES = {
  extension: true,
  dictionary: true,
};

const hasOwnProperty = Function.call.bind(Object.prototype.hasOwnProperty);

function isXPI(filename) {
  let ext = filename.slice(-4).toLowerCase();
  return ext === ".xpi" || ext === ".zip";
}

/**
 * Gets an nsIURI for a file within another file, either a directory or an XPI
 * file. If aFile is a directory then this will return a file: URI, if it is an
 * XPI file then this will return a jar: URI.
 *
 * @param {nsIFile} aFile
 *        The file containing the resources, must be either a directory or an
 *        XPI file
 * @param {string} aPath
 *        The path to find the resource at, '/' separated. If aPath is empty
 *        then the uri to the root of the contained files will be returned
 * @returns {nsIURI}
 *        An nsIURI pointing at the resource
 */
function getURIForResourceInFile(aFile, aPath) {
  if (!isXPI(aFile.leafName)) {
    let resource = aFile.clone();
    if (aPath) aPath.split("/").forEach((part) => resource.append(part));

    return Services.io.newFileURI(resource);
  }

  return buildJarURI(aFile, aPath);
}

/**
 * Creates a jar: URI for a file inside a ZIP file.
 *
 * @param {nsIFile} aJarfile
 *        The ZIP file as an nsIFile
 * @param {string} aPath
 *        The path inside the ZIP file
 * @returns {nsIURI}
 *        An nsIURI for the file
 */
function buildJarURI(aJarfile, aPath) {
  let uri = Services.io.newFileURI(aJarfile);
  uri = "jar:" + uri.spec + "!/" + aPath;
  return Services.io.newURI(uri);
}

var BootstrapLoader = {
  name: "bootstrap",
  manifestFile: "install.rdf",
  async loadManifest(pkg) {
    /**
     * Reads locale properties from either the main install manifest root or
     * an em:localized section in the install manifest.
     *
     * @param {Object} aSource
     *        The resource to read the properties from.
     * @param {boolean} isDefault
     *        True if the locale is to be read from the main install manifest
     *        root
     * @param {string[]} aSeenLocales
     *        An array of locale names already seen for this install manifest.
     *        Any locale names seen as a part of this function will be added to
     *        this array
     * @returns {Object}
     *        an object containing the locale properties
     */
    function readLocale(aSource, isDefault, aSeenLocales) {
      let locale = {};
      if (!isDefault) {
        locale.locales = [];
        for (let localeName of aSource.locales || []) {
          if (!localeName) {
            logger.warn("Ignoring empty locale in localized properties");
            continue;
          }
          if (aSeenLocales.includes(localeName)) {
            logger.warn("Ignoring duplicate locale in localized properties");
            continue;
          }
          aSeenLocales.push(localeName);
          locale.locales.push(localeName);
        }

        if (locale.locales.length == 0) {
          logger.warn("Ignoring localized properties with no listed locales");
          return null;
        }
      }

      for (let prop of [...PROP_LOCALE_SINGLE, ...PROP_LOCALE_MULTI]) {
        if (hasOwnProperty(aSource, prop)) {
          locale[prop] = aSource[prop];
        }
      }

      return locale;
    }

    let manifestData = await pkg.readString("install.rdf");
    let manifest = InstallRDF.loadFromString(manifestData).decode();

    let addon = new AddonInternal();
    for (let prop of PROP_METADATA) {
      if (hasOwnProperty(manifest, prop)) {
        addon[prop] = manifest[prop];
      }
    }

    if (!addon.type) {
      addon.type = "extension";
    } else {
      let type = addon.type;
      addon.type = null;
      for (let name in TYPES) {
        if (TYPES[name] == type) {
          addon.type = name;
          break;
        }
      }
    }

    if (!(addon.type in TYPES))
      throw new Error("Install manifest specifies unknown type: " + addon.type);

    if (!addon.id) throw new Error("No ID in install manifest");
    if (!gIDTest.test(addon.id))
      throw new Error("Illegal add-on ID " + addon.id);
    if (!addon.version) throw new Error("No version in install manifest");

    addon.strictCompatibility =
      !(addon.type in COMPATIBLE_BY_DEFAULT_TYPES) ||
      manifest.strictCompatibility == "true";

    // Only read these properties for extensions.
    if (addon.type == "extension") {
      if (manifest.bootstrap != "true") {
        throw new Error("Non-restartless extensions no longer supported");
      }

      if (
        addon.optionsType &&
        addon.optionsType != 1 /*AddonManager.OPTIONS_TYPE_DIALOG*/ &&
        addon.optionsType != AddonManager.OPTIONS_TYPE_INLINE_BROWSER &&
        addon.optionsType != AddonManager.OPTIONS_TYPE_TAB
      ) {
        throw new Error(
          "Install manifest specifies unknown optionsType: " +
            addon.optionsType,
        );
      }

      if (addon.optionsType) addon.optionsType = parseInt(addon.optionsType);
    }

    addon.defaultLocale = readLocale(manifest, true);

    let seenLocales = [];
    addon.locales = [];
    for (let localeData of manifest.localized || []) {
      let locale = readLocale(localeData, false, seenLocales);
      if (locale) addon.locales.push(locale);
    }

    let dependencies = new Set(manifest.dependencies);
    addon.dependencies = Object.freeze(Array.from(dependencies));

    let seenApplications = [];
    addon.targetApplications = [];
    for (let targetApp of manifest.targetApplications || []) {
      if (!targetApp.id || !targetApp.minVersion || !targetApp.maxVersion) {
        logger.warn(
          "Ignoring invalid targetApplication entry in install manifest",
        );
        continue;
      }
      if (seenApplications.includes(targetApp.id)) {
        logger.warn(
          "Ignoring duplicate targetApplication entry for " +
            targetApp.id +
            " in install manifest",
        );
        continue;
      }
      seenApplications.push(targetApp.id);
      addon.targetApplications.push(targetApp);
    }

    // Note that we don't need to check for duplicate targetPlatform entries since
    // the RDF service coalesces them for us.
    addon.targetPlatforms = [];
    for (let targetPlatform of manifest.targetPlatforms || []) {
      let platform = {
        os: null,
        abi: null,
      };

      let pos = targetPlatform.indexOf("_");
      if (pos != -1) {
        platform.os = targetPlatform.substring(0, pos);
        platform.abi = targetPlatform.substring(pos + 1);
      } else {
        platform.os = targetPlatform;
      }

      addon.targetPlatforms.push(platform);
    }

    addon.userDisabled = false;
    addon.softDisabled = addon.blocklistState == Blocklist.STATE_SOFTBLOCKED;
    addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DEFAULT;

    addon.userPermissions = null;

    addon.icons = {};
    if (await pkg.hasResource("icon.png")) {
      addon.icons[32] = "icon.png";
      addon.icons[48] = "icon.png";
    }

    if (await pkg.hasResource("icon64.png")) {
      addon.icons[64] = "icon64.png";
    }

    Object.defineProperty(addon, "appDisabled", {
      set: (_) => {},
      get: (_) => false,
    });

    Object.defineProperty(addon, "signedState", {
      set: (_) => {},
      get: (_) => AddonManager.SIGNEDSTATE_NOT_REQUIRED,
    });

    return addon;
  },

  loadScope(addon) {
    let file = addon.file || addon._sourceBundle;
    let uri = getURIForResourceInFile(file, "bootstrap.js").spec;
    let principal = Services.scriptSecurityManager.getSystemPrincipal();

    let sandbox = new Cu.Sandbox(principal, {
      sandboxName: uri,
      addonId: addon.id,
      wantGlobalProperties: ["ChromeUtils"],
      metadata: { addonID: addon.id, URI: uri },
    });

    try {
      Object.assign(sandbox, BOOTSTRAP_REASONS);

      ChromeUtils.defineLazyGetter(
        sandbox,
        "console",
        () => new ConsoleAPI({ consoleID: `addon/${addon.id}` }),
      );

      // Services.scriptloader.loadSubScript(uri, sandbox);

      let isDone = false;
      let loadError;
      ChromeUtils.compileScript(uri)
        .then((script) => script.executeInGlobal(sandbox))
        .catch((error) => (loadError = error))
        .finally(() => (isDone = true));
      Services.tm.spinEventLoopUntil(
        "Waiting for bootstrap.js to load",
        () => isDone,
      );
      if (loadError) throw loadError;

      // Cu.evalInSandbox(readFromJarURI(getURIForResourceInFile(file, 'bootstrap.js')), sandbox, null ,uri);
    } catch (e) {
      logger.warn(`Error loading bootstrap.js for ${addon.id}`, e);
    }

    function findMethod(name) {
      if (sandbox[name]) {
        return sandbox[name];
      }

      try {
        let method = Cu.evalInSandbox(name, sandbox);
        return method;
      } catch (err) {}

      return () => {
        logger.warn(`Add-on ${addon.id} is missing bootstrap method ${name}`);
      };
    }

    let install = findMethod("install");
    let uninstall = findMethod("uninstall");
    let startup = findMethod("startup");
    let shutdown = findMethod("shutdown");

    /**
     * Reads content from a jar: URI
     *
     * @param {nsIURI} jarURI - The jar: URI to read from
     * @returns {string} The content of the file inside the JAR
     */
    function readFromJarURI(jarURI) {
      try {
        const input = Services.io
          .newChannelFromURI(
            jarURI,
            null,
            Services.scriptSecurityManager.getSystemPrincipal(),
            null,
            Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
            Ci.nsIContentPolicy.TYPE_OTHER,
          )
          .open();

        const data = NetUtil.readInputStreamToString(input, input.available(), {
          charset: "UTF-8",
        });
        input.close();
        return data;
      } catch (e) {
        throw e;
      }
    }

    function absolutizePaths(file, line) {
      const manifestMethodPathLocation = {
        component: 2,
        contract: 2,
        content: 2,
        locale: 3,
        skin: 3,
        resource: 2,
        overlay: 2,
        style: 2,
      };
      const isRelative = (loc) => {
        return typeof loc === "string" && !loc.match(/^(?:[a-zA-Z]+:|\\)/);
      };

      let words = line.trim().split(/\s+/);
      const index = manifestMethodPathLocation[words[0]];

      if (index && isRelative(words[index])) {
        words[index] = getURIForResourceInFile(file, words[index]).spec;
        line = words.join(" ");
      }

      return line;
    }

    // Register a chrome manifest temporarily and return a function which un-does
    // the registrarion when no longer needed.
    let tempDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    tempDir.append("browser-extension-data");
    tempDir.append(addon.id);

    function createManifestTemporarily(manifestText) {
      let tempFile = tempDir.clone();
      tempFile.append(`chrome.manifest.${Services.uuid.generateUUID()}`);

      let foStream = Cc[
        "@mozilla.org/network/file-output-stream;1"
      ].createInstance(Ci.nsIFileOutputStream);
      foStream.init(tempFile, 0x02 | 0x08 | 0x20, 0o664, 0);
      foStream.write(manifestText, manifestText.length);
      foStream.close();

      Components.manager
        .QueryInterface(Ci.nsIComponentRegistrar)
        .autoRegister(tempFile);
      Cc["@mozilla.org/uriloader/external-helper-app-service;1"]
        .getService(Ci.nsPIExternalAppLauncher)
        .deleteTemporaryFileOnExit(tempFile);

      return function () {
        tempFile.fileSize = 0;
        Cc["@mozilla.org/chrome/chrome-registry;1"]
          .getService(Ci.nsIXULChromeRegistry)
          .checkForNewChrome();
      };
    }

    return {
      install(...args) {
        install(...args);
        if (args[1] == BOOTSTRAP_REASONS.ADDON_INSTALL) {
          Services.obs.notifyObservers(null, "startupcache-invalidate");
        }
      },

      uninstall(...args) {
        uninstall(...args);
        Services.obs.notifyObservers(null, "startupcache-invalidate");
      },

      startup(...args) {
        if (addon.type == "extension") {
          logger.debug(`Registering manifest for ${file.path}\n`);
          const manifestURI = getURIForResourceInFile(file, "chrome.manifest");
          let manifestData = readFromJarURI(manifestURI);
          let chromeManifest = manifestData
            .split("\n")
            .map(absolutizePaths.bind(null, file))
            .join("\n");
          this._clearManifest = createManifestTemporarily(chromeManifest);
        }
        return startup(...args);
      },

      shutdown(data, reason) {
        try {
          return shutdown(data, reason);
        } catch (err) {
          throw err;
        } finally {
          if (reason != BOOTSTRAP_REASONS.APP_SHUTDOWN) {
            logger.debug(`Removing manifest for ${file.path}\n`);
            this._clearManifest();
            this._clearManifest = null;
          }
        }
      },
    };
  },
};

AddonManager.addExternalExtensionLoader(BootstrapLoader);

if (AddonManager.isReady) {
  AddonManager.getAllAddons().then((addons) => {
    addons.forEach((addon) => {
      if (
        addon.type == "extension" &&
        !addon.isWebExtension &&
        !addon.userDisabled
      ) {
        addon.reload();
      }
    });
  });
}
```

## Verbatim — comment by onemen, 2026-09-02

I will look into it

## Verbatim — posted reply, 2026-09-05

🤖 AI comment by Codebuff agent — empirical investigation on Firefox 155.0.1

Nice write-up — I tested this instead of reasoning about it. Short version: the deletion is harmless; chrome keeps working across restarts either way. The shipped loader's fixed-name + manual cleanup is still the more robust design, though — for crash-litter reasons, not liveness ones.

**Why deleting the manifest can't break the next session.** The chrome registry does not persist dynamic manifest registrations across sessions. Every startup re-derives them from what gets `autoRegister`ed during _that_ session, and the loader re-registers at every startup. Whether the temp file is deleted at exit (your variant), truncated+removed on non-shutdown (repo), or left behind (APP_SHUTDOWN), the next session starts clean — and clearing the startup cache changes nothing (it holds compiled scripts, not registrations).

Verified with a real legacy bootstrap extension, probing `chrome://testext/content/test.html` from autoconfig at 1 s granularity:

| Scenario (same profile)       | repo loader          | discussion variant   |
| ----------------------------- | -------------------- | -------------------- |
| Fresh install                 | chrome live @ ~1.4 s | chrome live @ ~1.2 s |
| Plain restart                 | live @ ~1.2 s        | live @ ~1.2 s        |
| Clear startup cache + restart | live                 | live                 |
| Manifest after clean exit     | kept                 | deleted — reproduced |

**The "addon startup late" theory doesn't apply either.** Forcing the registration 30 s past startup, all three variants (repo, yours, yours + `checkForNewChrome()`) had chrome live again within ~1–6 s — `autoRegister` registers chrome inline whenever it runs, so nothing depends on a startup re-scan window. (#26's `compileScript` fix is in both loaders; #156 is the xiaoxiaoflood repo's overlay symptom — a different failure mode.)

**Where the variant is weaker: crash litter.** `deleteTemporaryFileOnExit` only fires on clean shutdown. Kill the browser and `chrome.manifest.<uuid>` stays behind — one per kill, accumulating forever (reproduced; the extension still works next restart). The fixed name + manual removal avoids the uuid litter (its own truncate-then-remove can still leave a 0-byte `chrome.manifest` if killed between the two steps — hence the startup sweep).

**Net:** nothing to fix in the repo — the shipped loader is the robust version of the same idea. If you keep the variant, switch to a fixed name + manual cleanup so crashes can't litter the profile; the deletion itself is a red herring. (Follow-up from this investigation: chrome-across-restarts E2E coverage plus a crash-litter startup sweep — deferred post-v1.)
