// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'Frontmatter CMS',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/da-shalev/astro-frontmatter-cms',
				},
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quick Start', slug: 'getting-started/quick-start' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Content Collections', slug: 'guides/content-collections' },
						{ label: 'Creating Blocks', slug: 'guides/creating-blocks' },
						{ label: 'Rendering Blocks', slug: 'guides/rendering-blocks' },
						{ label: 'Querying Blocks', slug: 'guides/querying-blocks' },
						{ label: 'IDE Completions', slug: 'guides/ide-completions' },
						{ label: 'Islands', slug: 'guides/islands' },
					],
				},
				{
					label: 'Reference',
					autogenerate: { directory: 'reference' },
				},
			],
		}),
	],
});
