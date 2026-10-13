import {docsLoader, i18nLoader} from '@astrojs/starlight/loaders';
import {docsSchema, i18nSchema} from '@astrojs/starlight/schema';
import {defineCollection} from 'astro:content';

export const collections = {
  docs: defineCollection({
    loader: docsLoader({
      importPreferences: false,
    }),
    schema: docsSchema({
      labels: {singular: 'doc'},
    }),
  }),
  // Single-locale site: one minimal file (en.json) keeps the collection
  // non-empty so Astro stops warning that "i18n" does not exist.
  i18n: defineCollection({
    loader: i18nLoader(),
    schema: i18nSchema(),
  }),
};
