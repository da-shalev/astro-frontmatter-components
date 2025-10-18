/// <reference types="astro/client" />

declare module 'virtual:astro-frontmatter-components' {
	import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
	export const components: Record<string, AstroComponentFactory>;
}
