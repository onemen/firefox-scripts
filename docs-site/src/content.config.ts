import {docsLoader, i18nLoader} from '@astrojs/starlight/loaders';
import {docsSchema, i18nSchema} from '@astrojs/starlight/schema';
import {defineCollection} from 'astro:content';

export const collections = {
  // No loader/schema options: the installed Starlight takes only generateId
  // (loader) and extend (schema); unknown keys fail `astro check`.
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema(),
  }),
  // Single-locale site: one minimal file (en.json) keeps the collection
  // non-empty so Astro stops warning that "i18n" does not exist.
  i18n: defineCollection({
    loader: i18nLoader(),
    schema: i18nSchema(),
  }),
};
