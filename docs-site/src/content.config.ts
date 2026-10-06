import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

export const collections = {
  docs: defineCollection({
    loader: docsLoader({
      importPreferences: false,
    }),
    schema: docsSchema({
      labels: { singular: "doc" },
    }),
  }),
};
