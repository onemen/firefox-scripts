/// <reference types="astro/client" />

// Types for Starlight's virtual user-config module: it exists only at build
// time (served by the integration), so without this declaration `astro check`
// cannot resolve the import in SocialIcons.astro.
declare module 'virtual:starlight/user-config' {
  import type {StarlightConfig} from '@astrojs/starlight/types';
  const config: StarlightConfig;
  export default config;
}
