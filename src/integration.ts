import type { AstroIntegration, AstroIntegrationLogger } from 'astro';
import type { Plugin } from 'vite';
import { parse } from '@typescript-eslint/typescript-estree';
import esbuild from 'esbuild';
import fs from 'fs/promises';
import { dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { globSync } from 'tinyglobby';
import { runtimeLogger } from '@inox-tools/runtime-logger';
import { isSchemaBuilder, type SchemaBuilder } from './schema';
import type { SchemaContext } from 'astro:content';
import { z } from 'zod';

export type SchemaComponent = {
	/// The filename used as a UID for the schemas (e.g., 'Hero'), excluding the '.astro' extension.
	type: string;

	/// The relative path to the schemas's Astro component
	path: string;

	/// The Zod schema builder which creates the data structure for validation.
	schema: SchemaBuilder;
};

export type SchemaMeta = z.infer<ReturnType<typeof parseBlocks>>[number];

/**
 * Registry that maps schema type identifiers to their component implementations.
 *
 * @property components - Maps type to SchemaComponent
 * @property id - Unique symbol identifier for this registry instance
 */
export interface SchemaRegistry {
	components: Record<string, SchemaComponent>;
	id: symbol;
}

declare global {
	var __astroFrontmatterComponentRegistry: SchemaRegistry | undefined;
}

export function getRegistry(): SchemaRegistry {
	return (globalThis.__astroFrontmatterComponentRegistry ??= {
		components: {},
		id: Symbol('schema'),
	});
}

export function glob(patterns: string | string[]) {
	return globSync(patterns, {
		absolute: true,
		onlyFiles: true,
		ignore: ['**/node_modules/**'],
	});
}

/**
 * @returns boolean - if the type is new to the registry
 */
function buildAstroBlock(path: string, logger: AstroIntegrationLogger, schema?: unknown) {
	const registry = getRegistry();
	if (!isSchemaBuilder(schema, registry)) {
		logger.error(
			`Invalid schema at ${path}. Schema must be created with createSchema. Refer to docs.`,
		);
		return;
	}

	if (registry.components[schema.type]) {
		logger.error(
			`Invalid ${schema.type} at ${path}. Duplicate ${schema.type} at: ${registry.components[schema.type]?.path}.`,
		);
		return;
	}

	logger.info(`Registered new component: ${schema.type}`);

	registry.components[schema.type] = {
		type: schema.type,
		path,
		schema,
	};
}

/**
 * Parses an array of blocks using the registered block types, rejecting any unknown ones.
 *
 * @param c - SchemaContext needed for resolving paths of images.
 */
export function parseBlocks(c: SchemaContext) {
	const registry = getRegistry();
	const blocks = Object.values(registry.components).map((block) => {
		return z.object({
			type: z.literal(block.type),
			...block.schema(c),
		});
	});

	if (blocks.length == 0) {
		console.warn('No blocks were initialized. A empty schema will be returned.');
		return z.array(z.any());
	}

	const [first, ...rest] = blocks;
	return z.array(z.discriminatedUnion('type', [first!, ...rest!]));
}

export type AstroFrontmatterComponents = {
	paths: string[];
};

const NAME: string = 'astro-frontmatter-components';
const VIRTUAL_NAME: string = `virtual:astro-frontmatter-components`;
const VIRTUAL_SCHEMA_MAP: string = `virtual:astro-frontmatter-schemas:`;
const virtual = (id: string) => `\0${id}`;
const isVirtual = (id: string) => id.startsWith('\0');

function mkVitePlugin(opt: AstroFrontmatterComponents, logger: AstroIntegrationLogger): Plugin {
	const virtualModules = new Map();
	return {
		name: NAME,
		resolveId(id, importer) {
			if (id.startsWith(VIRTUAL_SCHEMA_MAP)) return virtual(id);
			if (id === VIRTUAL_NAME) return virtual(VIRTUAL_NAME);

			if (importer?.startsWith(virtual(VIRTUAL_SCHEMA_MAP)) && id.startsWith('./')) {
				const data = virtualModules.get(importer);
				return data ? resolve(dirname(data.realPath), id) : null;
			}
		},

		load(id) {
			if (isVirtual(id) && id.includes(VIRTUAL_SCHEMA_MAP)) {
				return virtualModules.get(id)?.code;
			}

			// Generates static imports for SSR builds.
			// Dynamic import() of .astro files fails during SSR compilation.
			// which is why the path from the registry cannot be directly used
			if (id === virtual(VIRTUAL_NAME)) {
				const registry = getRegistry();
				const imports = Object.values(registry.components)
					.map((block) => {
						return `import ${block.type} from '${block.path}';`;
					})
					.join('\n');

				const map = Object.values(registry.components)
					.map((block) => {
						return `'${block.type}': ${block.type}`;
					})
					.join(',\n');

				return `${imports}\n\nexport const components = {\n${map}\n};`;
			}
		},

		configureServer: {
			async handler(server) {
				for (const path of opt.paths) {
					// TODO: make sure this is more correct
					const file = await fs.readFile(path, 'utf-8');
					const parts = file.split('---');
					const frontmatter = parts[1];

					// TODO: don't fail silently
					if (!frontmatter) continue;

					const ast = parse(frontmatter, {
						jsx: true,
						range: true,
						comment: true,
					});

					const imports = ast.body
						.filter((node) => node.type === 'ImportDeclaration')
						.map((node) => frontmatter.slice(node.range[0], node.range[1]))
						.join('\n');

					const schemaExport = ast.body.find((node) => node.type === 'ExportNamedDeclaration');

					// TODO: don't fail silently
					if (!schemaExport) continue;

					const codeToBundle = `${imports}\n${frontmatter.slice(schemaExport.range[0], schemaExport.range[1])}`;

					const result = await esbuild.build({
						stdin: {
							contents: codeToBundle,
							loader: 'ts',
							resolveDir: dirname(path),
						},
						bundle: true,
						format: 'esm',
						write: false,
						// TODO: mark anything from node_modules as external or maybe everything?
						external: ['astro:content', '@it-astro:*', '*.astro', 'astro-frontmatter-components'],
					});

					// TODO: don't fail silently
					if (!result.outputFiles[0]) continue;

					const bundledCode = result.outputFiles[0].text;

					const hash = createHash('md5').update(path).digest('hex');
					const virtualId = `${VIRTUAL_SCHEMA_MAP}${hash}`;

					virtualModules.set(virtual(virtualId), { code: bundledCode, realPath: path });

					const module = await server.ssrLoadModule(virtualId);

					if (module?.schema) {
						buildAstroBlock(path, logger, module.schema);
					}
				}
			},
		},
	};
}

// TODO: improve formatting
export function frontmatterComponents(opt: AstroFrontmatterComponents): AstroIntegration {
	return {
		name: NAME,

		hooks: {
			'astro:config:setup': async (params) => {
				runtimeLogger(params, {
					name: NAME,
				});

				params.updateConfig({
					vite: {
						plugins: [mkVitePlugin(opt, params.logger)],
					},
				});
			},
		},
	};
}

// TODO: this
// 'astro:server:setup': async ({ server, refreshContent, logger }) => {
// 	const registry = getRegistry();
// 	server.watcher.on('change', async (path: string) => {
// 		// if (!path.endsWith('.astro')) {
// 		// 	return;
// 		// }
// 		// const component = await server.ssrLoadModule(path);
//
// 		// check if the type is notg entirely new, if not the content cache
// 		// does not need to be invalidated
// 		// const registry = getRegistry();
// 		// if (!buildAstroBlock(path, logger, registry, component.schema)) {
// 		// 	return;
// 		// }
//
// 		// BUG: invalidate cache
// 		// below is a hack I wrote, I'll be opening up an issue
//
// 		// let content = await readFile(configPath, 'utf-8');
// 		// await writeFile(configPath, content + '\n', 'utf-8');
// 		//
// 		// server.moduleGraph.invalidateAll();
// 		// server.ws.send({
// 		// 	type: 'full-reload',
// 		// });
// 	});
//
// 	server.watcher.on('unlink', async (path: string) => {
// 		if (!path.endsWith('.astro')) {
// 			return;
// 		}
//
// 		const type = getType(path);
// 		if (type != null) {
// 			delete registry[type];
// 		}
// 	});
// },
