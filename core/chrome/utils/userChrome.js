/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

// Reads platformVersion (Gecko) rather than version so forks (Waterfox,
// LibreWolf, Floorp, Zen) that carry their own brand version still get the
// correct Gecko-level semantics.
function isFirefox149Plus(appinfo) {
  const major = parseInt(String(appinfo && appinfo.platformVersion), 10);
  return Number.isInteger(major) && major >= 149;
}
const FF149 = isFirefox149Plus(Services.appinfo);

ChromeUtils.defineESModuleGetters(this, {
  xPref: 'chrome://userchromejs/content/xPref.sys.mjs',
  Management: 'resource://gre/modules/Extension.sys.mjs',
  AppConstants: 'resource://gre/modules/AppConstants.sys.mjs',
});

const UC = {
  webExts: new Map(),
  sidebar: new Map(),
  sandboxes: new WeakMap(),
};

const _uc = {
  ALWAYSEXECUTE: 'rebuild_userChrome.uc.js',
  BROWSERCHROME:
    AppConstants.MOZ_APP_NAME == 'thunderbird' ?
      'chrome://messenger/content/messenger.xhtml'
    : 'chrome://browser/content/browser.xhtml',
  BROWSERTYPE: AppConstants.MOZ_APP_NAME == 'thunderbird' ? 'mail:3pane' : 'navigator:browser',
  BROWSERNAME:
    AppConstants.MOZ_APP_NAME.charAt(0).toUpperCase() + AppConstants.MOZ_APP_NAME.slice(1),
  PREF_ENABLED: 'userChromeJS.enabled',
  PREF_SCRIPTSDISABLED: 'userChromeJS.scriptsDisabled',

  chromedir: Services.dirsvc.get('UChrm', Ci.nsIFile),
  scriptsDir: '',

  sss: Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService),

  getScripts: function () {
    this.scripts = {};
    const files = this.chromedir.directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
    while (files.hasMoreElements()) {
      const file = files.getNext().QueryInterface(Ci.nsIFile);
      if (/\.uc\.js$/i.test(file.leafName)) {
        _uc.getScriptData(file);
      }
    }
  },

  getScriptData: function (aFile) {
    const aContent = this.readFile(aFile);
    /* Fixed literal header pattern (non-greedy, no user data), not
     * attacker-controlled. eslint-disable: this repo's security linter
     * flags the nested-quantifier shape, but the pattern is a fixed
     * literal over script headers. */
    /* eslint-disable security/detect-unsafe-regex */
    const header = (aContent.match(
      /^\/\/ ==UserScript==\s*\n(?:.*\n)*?\/\/ ==\/UserScript==\s*\n/m
    ) || [''])[0];
    /* eslint-enable security/detect-unsafe-regex */
    const rex = {
      include: [],
      exclude: [],
    };
    let match;
    const findNextRe = /^\/\/ @(include|exclude)\s+(.+)\s*$/gm;
    while ((match = findNextRe.exec(header))) {
      rex[match[1]].push(match[2].replace(/^main$/i, _uc.BROWSERCHROME).replace(/\*/g, '.*?'));
    }
    if (!rex.include.length) {
      rex.include.push(_uc.BROWSERCHROME);
    }
    const exclude = rex.exclude.length ? '(?!' + rex.exclude.join('$|') + '$)' : '';

    const def = ['', ''];
    const author = (header.match(/\/\/ @author\s+(.+)\s*$/im) || def)[1];
    const filename = aFile.leafName || '';

    return (this.scripts[filename] = {
      filename: filename,
      file: aFile,
      url: 'resource://userchromejs/' + filename,
      name: (header.match(/\/\/ @name\s+(.+)\s*$/im) || def)[1],
      description: (header.match(/\/\/ @description\s+(.+)\s*$/im) || def)[1],
      version: (header.match(/\/\/ @version\s+(.+)\s*$/im) || def)[1],
      author: (header.match(/\/\/ @author\s+(.+)\s*$/im) || def)[1],
      /* Built from the script's own @include/@exclude metadata the user
       * wrote. eslint-disable: not attacker-controlled input. */
      /* eslint-disable security/detect-non-literal-regexp */
      regex: new RegExp('^' + exclude + '(' + (rex.include.join('|') || '.*') + ')$', 'i'),
      /* eslint-enable security/detect-non-literal-regexp */
      id: (header.match(/\/\/ @id\s+(.+)\s*$/im) || [
        '',
        filename.split('.uc.js')[0] + '@' + (author || 'userChromeJS'),
      ])[1],
      homepageURL: (header.match(/\/\/ @homepageURL\s+(.+)\s*$/im) || def)[1],
      downloadURL: (header.match(/\/\/ @downloadURL\s+(.+)\s*$/im) || def)[1],
      updateURL: (header.match(/\/\/ @updateURL\s+(.+)\s*$/im) || def)[1],
      optionsURL: (header.match(/\/\/ @optionsURL\s+(.+)\s*$/im) || def)[1],
      startup: (header.match(/\/\/ @startup\s+(.+)\s*$/im) || def)[1],
      shutdown: (header.match(/\/\/ @shutdown\s+(.+)\s*$/im) || def)[1],
      onlyonce: /\/\/ @onlyonce\b/.test(header),
      isRunning: false,
      get isEnabled() {
        return (xPref.get(_uc.PREF_SCRIPTSDISABLED) || '').split(',').indexOf(this.filename) == -1;
      },
    });
  },

  readFile: function (aFile, metaOnly = false) {
    const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(
      Ci.nsIFileInputStream
    );
    stream.init(aFile, 0x01, 0, 0);
    const cvstream = Cc['@mozilla.org/intl/converter-input-stream;1'].createInstance(
      Ci.nsIConverterInputStream
    );
    cvstream.init(stream, 'UTF-8', 1024, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
    const data = {};
    let content = '';
    while (cvstream.readString(4096, data)) {
      content += data.value;
      if (metaOnly && content.indexOf('// ==/UserScript==') > 0) {
        break;
      }
    }
    cvstream.close();
    return content.replace(/\r\n?/g, '\n');
  },

  everLoaded: [],

  loadScript: function (script, win) {
    if (
      !script.regex.test(win.location.href) ||
      (script.filename != this.ALWAYSEXECUTE && !script.isEnabled)
    ) {
      return;
    }

    if (script.onlyonce && script.isRunning) {
      if (script.startup) {
        Cu.evalInSandbox(`(function(script, win){${script.startup}})`, this.getSandbox(win))(
          script,
          win
        );
      }
      return;
    }

    try {
      Services.scriptloader.loadSubScript(
        script.url + '?' + script.file.lastModifiedTime,
        script.onlyonce ? {window: win} : win
      );
      script.isRunning = true;
      if (script.startup) {
        Cu.evalInSandbox(`(function(script, win){${script.startup}})`, this.getSandbox(win))(
          script,
          win
        );
      }
      if (!script.shutdown) {
        this.everLoaded.push(script.id);
      }
    } catch (ex) {
      Cu.reportError(ex);
    }
  },

  getSandbox: function (doc) {
    if (!UC.sandboxes) UC.sandboxes = new WeakMap();
    const global = Cu.getGlobalForObject(doc);
    if (UC.sandboxes.has(global)) return UC.sandboxes.get(global);
    const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
      sandboxPrototype: global,
      sameZoneAs: global,
      wantXrays: false,
      sandboxName: 'UCJS:Sandbox',
    });
    UC.sandboxes.set(global, sb);
    global.addEventListener('unload', () => {
      UC.sandboxes.delete(global);
      Cu.nukeSandbox(sb);
    });
    return sb;
  },

  windows: function (fun, onlyBrowsers = true) {
    const windows = Services.wm.getEnumerator(onlyBrowsers ? this.BROWSERTYPE : null);
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      if (!win._uc) continue;
      if (!onlyBrowsers) {
        const frames = win.docShell.getAllDocShellsInSubtree(
          Ci.nsIDocShellTreeItem.typeAll,
          Ci.nsIDocShell.ENUMERATE_FORWARDS
        );
        const res = frames.some(frame => {
          const fWin = frame.domWindow;
          const {document, location} = fWin;
          if (fun(document, fWin, location)) return true;
        });
        if (res) break;
      } else {
        const {document, location} = win;
        if (fun(document, win, location)) break;
      }
    }
  },

  // Bug 2008041 — Make XUL disabled / checked attributes html-style boolean
  // attributes (https://bugzilla.mozilla.org/show_bug.cgi?id=2008041).
  // Firefox 149+ evaluates boolean attrs by presence: toggleAttribute
  // instead of setAttribute for boolean / 'true' / 'false' values.
  createElement: function (doc, tag, atts, XUL = true) {
    const el = XUL ? doc.createXULElement(tag) : doc.createElement(tag);
    for (const att in atts) {
      if (att.startsWith('on'))
        el.addEventListener(
          att.slice(2),
          typeof atts[att] == 'string' ?
            Cu.evalInSandbox(`(function(event){${atts[att]}})`, this.getSandbox(doc))
          : atts[att]
        );
      else if (
        FF149 &&
        (typeof atts[att] === 'boolean' || atts[att] === 'true' || atts[att] === 'false')
      )
        el.toggleAttribute(att, atts[att] === true || atts[att] === 'true');
      else el.setAttribute(att, atts[att]);
    }
    return el;
  },
};

if (xPref.get(_uc.PREF_ENABLED) === undefined) {
  xPref.set(_uc.PREF_ENABLED, true, true);
}

if (xPref.get(_uc.PREF_SCRIPTSDISABLED) === undefined) {
  xPref.set(_uc.PREF_SCRIPTSDISABLED, '', true);
}

const UserChrome_js = {
  observe: function (aSubject) {
    if (
      AppConstants.MOZ_APP_NAME == 'thunderbird' &&
      aSubject?.location?.href.startsWith('chrome://messenger/content')
    ) {
      aSubject.addEventListener(
        'DOMContentLoaded',
        () => {
          this.load(aSubject);
        },
        {once: true}
      );
    } else {
      aSubject.addEventListener('DOMContentLoaded', this, {once: true});
    }
  },

  handleEvent: function (aEvent) {
    const document = aEvent.originalTarget;
    const window = document.defaultView;
    if (window.document.isInitialDocument) {
      this.load(window.parent);
    } else {
      this.load(window);
    }
  },

  load: function (window) {
    const location = window.location;

    if (!this.sharedWindowOpened && location.href == 'chrome://extensions/content/dummy.xhtml') {
      this.sharedWindowOpened = true;

      Management.on(
        'extension-browser-inserted',
        function (topic, browser) {
          browser.messageManager.addMessageListener(
            'Extension:BackgroundViewLoaded',
            this.messageListener.bind(this)
          );
        }.bind(this)
      );
    } else if (
      /^(chrome:(?!\/\/global\/content\/commonDialog\.x?html)|about:(?!blank))/i.test(location.href)
    ) {
      window.UC = UC;
      window._uc = _uc;
      window.xPref = xPref;
      if (window._gBrowser)
        // bug 1443849
        window.gBrowser = window._gBrowser;

      if (xPref.get(_uc.PREF_ENABLED)) {
        Object.values(_uc.scripts).forEach(script => {
          _uc.loadScript(script, window);
        });
      } else if (!UC.rebuild) {
        _uc.loadScript(_uc.scripts[_uc.ALWAYSEXECUTE], window);
      }
    }
  },

  messageListener: function (msg) {
    const browser = msg.target;
    const {addonId} = browser._contentPrincipal;

    browser.messageManager.removeMessageListener(
      'Extension:BackgroundViewLoaded',
      this.messageListener
    );
    const documentGlobal = browser.ownerGlobal ?? browser.documentGlobal;

    if (documentGlobal.location.href == 'chrome://extensions/content/dummy.xhtml') {
      UC.webExts.set(addonId, browser);
      Services.obs.notifyObservers(null, 'UCJS:WebExtLoaded', addonId);
    } else {
      const windowRoot = documentGlobal.windowRoot;
      const win = windowRoot.ownerGlobal ?? windowRoot.documentGlobal;
      UC.sidebar.get(addonId)?.set(win, browser) ||
        UC.sidebar.set(addonId, new Map([[win, browser]]));
      Services.obs.notifyObservers(win, 'UCJS:SidebarLoaded', addonId);
    }
  },
};

if (!Services.appinfo.inSafeMode) {
  _uc.chromedir.append(_uc.scriptsDir);
  _uc.getScripts();
  const windows = Services.wm.getEnumerator(null);
  while (windows.hasMoreElements()) {
    const win = windows.getNext();
    if (!('UC' in win)) UserChrome_js.load(win);
  }
  Services.obs.addObserver(UserChrome_js, 'chrome-document-global-created', false);
}

// Initialize firefox-scripts updater (idempotent — also initialized from
// BootstrapLoader.js; harmless if both run).
try {
  // NOTE: doc.documentURI is 'chrome://browser/content/browser.xhtml' (the
  // concatenated protocol+pathname form has a single slash and would never
  // match this literal).
  Services.obs.addObserver(doc => {
    if (doc.documentURI === 'chrome://browser/content/browser.xhtml') {
      const win = doc.defaultView;
      try {
        const {initScriptsUpdater} = ChromeUtils.importESModule(
          'chrome://firefox-scripts/content/scriptsUpdater.sys.mjs'
        );
        initScriptsUpdater(win);
      } catch {
        // scriptsUpdater not available
      }
    }
  }, 'chrome-document-loaded');
} catch {
  // Updater init failed
}
