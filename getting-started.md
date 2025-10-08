# How to use

I recommend you read through all of this, it documents edge cases.

## 1. Setup

Create the data which you need to parse:

```yaml
# src/content/services/index.md

title: 'My Homepage'
desc: 'Welcome to my site'
blocks:
  - type: Hero
    title: 'Build faster with Astro'
    desc: 'A simple way to structure your frontmatter into reusable, validated sections.'
    speed: 5.0
  - type: CTA
    heading: 'Join the newsletter'
    text: 'Get practical Astro tips, patterns, and updates in your inbox every Friday.'
```

## 2. Register components & parse frontmatter

Set up the registry which auto-imports components, then create a Zod schema that validates your blocks:

```ts
// src/content.config.ts

import { type SchemaContext, z, defineCollection } from 'astro:content';
import { registerAstroComponents, parseBlocks } from 'astro-frontmatter-components';

// registers all astro files within src/components that export "schema"
const registry = registerAstroComponents(
  import.meta.glob('./components/**/*.astro', {
    eager: true,
  }),
);

export const collections = {
  services: defineCollection({
    schema: (c: SchemaContext) =>
      z.object({
        title: z.string(),
        desc: z.string(),
        popular: z.array(z.string()),
        // parse the data which matches the registry
        blocks: parseBlocks(c, registry),
      }),
  }),
};
```

## 3. Define components

Create your reusable components as `.astro` files with exported schemas:

```ts
// src/components/Hero.astro

import type { SchemaOf, SchemaBuilder } from 'astro-frontmatter-components';
import { type SchemaContext, z } from 'astro:content';

export const schema: SchemaBuilder = (c: SchemaContext) => ({
  id: z.string().optional(),
  title: z.string(),
  speed: z.number().default(5.0),
});

// can be used on Astro islands!
export type Props = SchemaOf<typeof schema>;
const meta: Props = Astro.props;

// meta now appears as such to the lsp
const meta: {
  title: string;
  desc: string;
  speed: number;
  id?: string | undefined;
};
```

## 4. Render components

Load your content and render the blocks using the `<Frontmatter>` component:

```astro
---
// src/pages/services/index.astro
import Layout from '@/layouts/Layout.astro';
import { Frontmatter } from 'astro-frontmatter-components';
import { getEntry } from 'astro:content';
import { registry } from '@/content.config';

const index = await getEntry('services', 'index');
---

<Layout>
  <Frontmatter blocks={index?.data.blocks} {registry} />
</Layout>
```

# Additional details

## 1. Using components as islands

You can render Astro islands like any other Astro component.

> **Important**: When importing Props types for islands, use import type (namespace import):
>
> ```ts
> // correct
> import type { Props as Hero } from './components/Hero.astro';
>
> // incorrect
> import { type Props as Hero } from './components/Hero.astro';
> ```
