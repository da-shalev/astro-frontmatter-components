/// <reference types="astro/client" />

declare module 'virtual:astro-frontmatter-components' {
	import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
	const components: Record<string, AstroComponentFactory>;
	export default components;
}
