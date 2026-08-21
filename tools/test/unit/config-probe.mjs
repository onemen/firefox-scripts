// tools/test/unit/config-probe.mjs — Print the generated updater-config module
// for the argv this process was started with (--mode=prod|dev, --local), so the
// unit test can verify per-mode URLs/flags by spawning child processes.

import {
  readConfig,
  generateModule,
  effectiveConfig,
} from '../../../tools/publish/generateUpdaterConfig.mjs';

const config = readConfig();
process.stdout.write(
  JSON.stringify({
    module: generateModule(config),
    effective: effectiveConfig(config),
  })
);
