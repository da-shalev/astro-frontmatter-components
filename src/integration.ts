import type { AstroIntegration, AstroIntegrationLogger } from 'astro';
import { parse } from '@typescript-eslint/typescript-estree';
import esbuild from 'esbuild';
import fs from 'fs/promises';
import { dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { globSync } from 'tinyglobby';
import { runtimeLogger } from '@inox-tools/runtime-logger';
import { getType, isSchemaBuilder, type SchemaBuilder } from './schema';
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
 * Maps schema identifiers to their component implementations.
 *
 * This registry is populated by {@link registerAstro}
 * Each key is a schema's type field (the block identifier), and each value is the corresponding Astro component.
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
function buildAstroBlock(
	path: string,
	logger: AstroIntegrationLogger,
	registry: SchemaRegistry,
	schema?: unknown,
): boolean {
	if (!isSchemaBuilder(schema, registry)) {
		logger.error(
			`Invalid schema at ${path}. Schema must be created with createSchema. Refer to docs.`,
		);
		return false;
	}

	const type = getType(path);

	if (type == undefined) {
		logger.error(`Unable to create name for path: ${path}.`);
		return false;
	}

	// let isNew = !(schema.uid in registry);
	// if (isNew) {
	logger.info(`Registered new component: ${type}`);
	// }

	registry.components[type] = {
		type,
		path,
		schema,
	};

	return true;
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

	const validTypes = new Set(blocks.map((s) => s.shape.type._def.value));
	const [first, ...rest] = blocks;

	return z.preprocess(
		(data: any) => {
			const warnings: string[] = [];

			// filters out any duplicate types
			const filtered = data.filter((block: any) => {
				if (block?.type && !validTypes.has(block.type)) {
					warnings.push(block.type);
					return false;
				}

				return true;
			});

			if (warnings.length > 0) {
				console.warn(
					`Unknown block types were parsed: ${warnings.join(', ')}. They will not show.`,
				);
			}

			return filtered;
		},

		z.array(z.discriminatedUnion('type', [first!, ...rest!])),
	);
}

export type AstroFrontmatterComponents = {
	components: string[];
};

const INTEGRATION_NAME: string = 'astro-frontmatter-components';
const VIRTUAL: string = `virtual:astro-frontmatter-components`;
const virtual = (id: string) => `\0${id}`;
const isVirtual = (id: string) => id.startsWith('\0');

export function frontmatterComponents({
	components,
}: AstroFrontmatterComponents): AstroIntegration {
	return {
		name: INTEGRATION_NAME,

		hooks: {
			'astro:config:setup': async (params) => {
				runtimeLogger(params, {
					name: INTEGRATION_NAME,
				});

				const virtualModules = new Map();

				params.updateConfig({
					vite: {
						plugins: [
							{
								name: INTEGRATION_NAME,
								resolveId(id, importer) {
									if (id.startsWith('virtual:schema:')) return virtual(id);
									if (id === VIRTUAL) return virtual(VIRTUAL);

									if (importer?.startsWith(virtual('virtual:schema:')) && id.startsWith('./')) {
										const data = virtualModules.get(importer);
										return data ? resolve(dirname(data.realPath), id) : null;
									}
								},

								load(id) {
									if (isVirtual(id) && id.includes('virtual:schema:')) {
										return virtualModules.get(id)?.code;
									}

									// Generates static imports for SSR builds.
									// Dynamic import() of .astro files fails during SSR compilation.
									// which is why the path from the registry cannot be directly used
									if (id === virtual(VIRTUAL)) {
										// Sanitize filenames to valid JS identifiers (e.g., 'hero-section' → 'hero_section')
										const toIdentifier = (str: string) =>
											str.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^[0-9]/, '_$&');

										const registry = getRegistry();
										const imports = Object.values(registry.components)
											.map((block) => {
												const id = toIdentifier(block.type);
												return `import ${id} from '${block.path}';`;
											})
											.join('\n');

										const map = Object.values(registry.components)
											.map((block) => {
												const id = toIdentifier(block.type);
												return `'${block.type}': ${id}`;
											})
											.join(',\n');

										return `${imports}\n\nexport const components = {\n${map}\n};`;
									}
								},

								configureServer: {
									async handler(server) {
										for (const path of components) {
											const file = await fs.readFile(path, 'utf-8');
											const parts = file.split('---');
											const frontmatter = parts[1];
											if (!frontmatter) {
												// don't fail silently
												continue;
											}

											const ast = parse(frontmatter, {
												jsx: true,
												range: true,
												comment: true,
											});

											const imports = ast.body
												.filter((node) => node.type === 'ImportDeclaration')
												.map((node) => frontmatter.slice(node.range[0], node.range[1]))
												.join('\n');

											const schemaExport = ast.body.find(
												(node) => node.type === 'ExportNamedDeclaration',
											);

											if (!schemaExport) {
												// don't fail silently
												continue;
											}

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
												external: [
													'astro:content',
													'@it-astro:*',
													'*.astro',
													'astro-frontmatter-components',
												],
											});

											const bundledCode = result.outputFiles[0].text;
											const hash = createHash('md5').update(path).digest('hex');
											const virtualId = `virtual:schema:${hash}`;

											virtualModules.set(virtual(virtualId), { code: bundledCode, realPath: path });

											const module = await server.ssrLoadModule(virtualId);

											if (module?.schema) {
												buildAstroBlock(path, params.logger, getRegistry(), module.schema);
											}
										}
									},
								},
							},
						],
					},
				});
			},
		},
	};
}

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
