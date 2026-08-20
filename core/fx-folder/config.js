// skip 1st line
lockPref('xpinstall.signatures.required', false);
lockPref('extensions.install_origins.enabled', false);

// Waterfox already bundles the legacy-extension BootstrapLoader (the old
// userChromeJS bootstrapping code), so loading ours would double-register it
// and may break legacy extensions.  Detect Waterfox and skip ONLY the BootstrapLoader
// load; userChrome.js and the updater still load normally (Waterfox users who
// install these files want the user-scripts and the auto-updater).
const isWaterfox = /waterfox/i.test(Services.appinfo.name);

try {
  const cmanifest = Services.dirsvc.get('UChrm', Ci.nsIFile);
  cmanifest.append('utils');
  cmanifest.append('chrome.manifest');
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(cmanifest);

  if (!isWaterfox) {
    Services.scriptloader.loadSubScript('chrome://userchromejs/content/BootstrapLoader.js');
  }
} catch (ex) {}

try {
  Services.scriptloader.loadSubScript('chrome://userchromejs/content/userChrome.js');
} catch (ex) {}
