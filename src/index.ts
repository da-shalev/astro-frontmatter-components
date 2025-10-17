import type { SchemaContext } from 'astro/content/config';
import type { AstroIntegration, AstroIntegrationLogger } from 'astro';
import { z } from 'zod';
import { runtimeLogger } from '@inox-tools/runtime-logger';
import { globSync } from 'tinyglobby';
import { parse } from '@typescript-eslint/typescript-estree';
import * as esbuild from 'esbuild';
import fs from 'fs/promises';
import { dirname, resolve } from 'path';
import { createHash } from 'crypto';

export function glob(patterns: string | string[]) {
	return globSync(patterns, {
		absolute: true,
		onlyFiles: true,
		ignore: ['**/node_modules/**'],
	});
}

/**
 * Extracts the inferred TypeScript type from a schema builder's Zod schema.
 *
 * @template T
 * @returns The inferred TypeScript type from the block's schema
 */
export type SchemaOf<T extends SchemaBuilder> = z.infer<z.ZodObject<ReturnType<T>>>;

export type SchemaMeta = z.infer<ReturnType<typeof parseBlocks>>[number];

/**
 * A function that builds a Zod schema shape for a specific context.
 */
export type SchemaBuilder = (c: SchemaContext) => z.ZodRawShape;

/**
 * Maps schema identifiers to their component implementations.
 *
 * This registry is populated by {@link registerAstro}
 * Each key is a schema's type field (the block identifier), and each value is the corresponding Astro component.
 */
export type SchemaRegistry = Record<string, SchemaComponent>;

type SchemaComponent = {
	/// The filename used as a UID for the schemas (e.g., 'Hero'), excluding the '.astro' extension.
	type: string;

	/// The relative path to the schemas's Astro component
	path: string;

	/// The Zod schema builder which creates the data structure for validation.
	schema: SchemaBuilder;
};

function getType(path: string): string | undefined {
	return path.split('/').pop()?.replace('.astro', '');
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
	if (schema == undefined) return false;
	const type = getType(path);
	if (type == undefined) {
		logger.error(`Unable to create id for path: ${path}. Report! big! bad! bug! rn!`);
		return false;
	}

	const prevPath = registry[type]?.path;

	delete registry[type];

	// it's a regular Astro component
	if (schema == null) {
		return false;
	}

	if (registry[type] && prevPath != path) {
		logger.warn(
			`Duplicate block ID '${type}' detected. Ignoring new entry at '${path}' and keeping existing entry at '${registry[type].path}'.`,
		);
		return false;
	}

	// ensure schema is a valid function
	if (typeof schema !== 'function') {
		logger.error(`Invalid schema at ${path}. Defined schema is not a function: ${typeof schema}.`);
		return false;
	}

	// builds the schema early to validate that it's being good
	// const testSchema = schema({} as SchemaContext);

	// ensure schema returns a a valid object
	// if (testSchema === null || typeof testSchema !== 'object') {
	// 	logger.error(
	// 		`Invalid schema at '${path}'. Expected a raw object ({ ... }), but received type '${typeof testSchema}'.`,
	// 	);
	// 	return false;
	// }

	// ensure schema returns a z.ZodRawShape not a z.ZodObject
	// if (testSchema.shape != null) {
	// 	logger.error(
	// 		`Invalid schema at '${path}'. Expected a raw object ({ ... }), but received a z.object()`,
	// 	);
	// 	return false;
	// }

	let isNew = false;
	if (!(type in registry)) {
		logger.info(`Registered new component: ${path}`);
		isNew = true;
	}

	registry[type] = {
		type,
		path,
		schema: schema as SchemaBuilder,
	};

	return isNew;
}

/**
 * Parses an array of blocks using the registered block types, rejecting any unknown ones.
 *
 * @param c - SchemaContext needed for resolving paths of images.
 */
export function parseBlocks(c: SchemaContext, logger: AstroIntegrationLogger) {
	const registry = getRegistry();
	const blocks = Object.values(registry).flatMap((block) => {
		return z.object({
			type: z.literal(block.type),
			...block.schema(c),
		});
	});

	if (blocks.length == 0) {
		logger.warn('No blocks were initialized. A empty schema will be returned.');
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
				logger.warn(`Unknown block types were parsed: ${warnings.join(', ')}. They will not show.`);
			}

			return filtered;
		},

		z.array(z.discriminatedUnion('type', [first!, ...rest!])),
	);
}

declare global {
	var __astroFrontmatterComponentRegistry: SchemaRegistry | undefined;
}

const SCHEMA_KEY = '__astroFrontmatterComponentRegistry' as const;

export function getRegistry(): SchemaRegistry {
	globalThis[SCHEMA_KEY] ??= {};
	return globalThis[SCHEMA_KEY];
}

export type AstroFrontmatterComponents = {
	enableLogger?: boolean;
	components: string[];
};

const INTEGRATION_NAME: string = 'astro-frontmatter-components';

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
									if (id.startsWith('virtual:schema:')) return '\0' + id;
									if (id === 'virtual:astro-components') return '\0virtual:astro-components';

									if (importer?.startsWith('\0virtual:schema:') && id.startsWith('./')) {
										const data = virtualModules.get(importer);
										return data ? resolve(dirname(data.realPath), id) : null;
									}
								},

								load(id) {
									if (id.startsWith('\0virtual:schema:')) {
										return virtualModules.get(id)?.code;
									}

									if (id === '\0virtual:astro-components') {
										const registry = getRegistry();
										const imports = Object.values(registry)
											.map((block, i) => `import Component${i} from '${block.path}';`)
											.join('\n');

										const map = Object.values(registry)
											.map((block, i) => `  '${block.type}': Component${i}`)
											.join(',\n');

										return `${imports}\nexport const componentMap = {\n${map}\n};`;
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
												external: ['astro:content', '@it-astro:*', '*.astro'],
											});

											const bundledCode = result.outputFiles[0].text;
											const hash = createHash('md5').update(path).digest('hex');
											const virtualId = '\0virtual:schema:' + hash;

											virtualModules.set(virtualId, { code: bundledCode, realPath: path });

											const module = await server.ssrLoadModule('virtual:schema:' + hash);

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

			'astro:server:setup': async ({ server, refreshContent, logger }) => {
				const registry = getRegistry();
				server.watcher.on('change', async (path: string) => {
					if (!path.endsWith('.astro')) {
						return;
					}
					const component = await server.ssrLoadModule(path);

					// check if the type is notg entirely new, if not the content cache
					// does not need to be invalidated
					const registry = getRegistry();
					if (!buildAstroBlock(path, logger, registry, component.schema)) {
						return;
					}

					// BUG: invalidate cache
					// below is a hack I wrote, I'll be opening up an issue

					// let content = await readFile(configPath, 'utf-8');
					// await writeFile(configPath, content + '\n', 'utf-8');
					//
					// server.moduleGraph.invalidateAll();
					// server.ws.send({
					// 	type: 'full-reload',
					// });
				});

				server.watcher.on('unlink', async (path: string) => {
					if (!path.endsWith('.astro')) {
						return;
					}

					const type = getType(path);
					if (type != null) {
						delete registry[type];
					}
				});
			},
		},
	};
}
