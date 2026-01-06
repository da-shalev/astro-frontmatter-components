import type { AstroIntegration, AstroIntegrationLogger } from 'astro';
import type { Plugin, ViteDevServer } from 'vite';
import { parse as parseastro } from '@astrojs/compiler';
import { parse } from '@babel/parser';
import { generate } from '@babel/generator';
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

	logger.info(`Registered new component: ${path}`);

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

const toVirtual = (id: string) => `\0${id}`;

const NAME: string = 'astro-frontmatter-components';
const VIRTUAL_NAME_ID: string = `virtual:${NAME}`;
const VIRTUAL_MAP_ID: string = `${VIRTUAL_NAME_ID}:`;
const VIRTUAL_MAP: string = toVirtual(VIRTUAL_MAP_ID);
const VIRTUAL_NAME: string = toVirtual(VIRTUAL_NAME_ID);

function mkVitePlugin(opt: AstroFrontmatterComponents, logger: AstroIntegrationLogger): Plugin {
	const virtualModules = new Map();

	async function handler(server: ViteDevServer) {
		for (const path of opt.paths) {
			const file = await fs.readFile(path, 'utf-8');
			const frontmatter = (await parseastro(file)).ast.children?.find(
				(node) => node.type === 'frontmatter',
			)?.value;

			if (!frontmatter) {
				console.warn(`No frontmatter found in ${path}. This is bug, report.`);
				continue;
			}

			const ast = parse(frontmatter, {
				sourceType: 'module',
				plugins: ['typescript', 'jsx'],
				ranges: true,
			});

			const schemaExport = ast.program.body.find((node) => node.type === 'ExportNamedDeclaration');
			if (!schemaExport) {
				logger.warn(`No schema export found in ${path}`);
				continue;
			}

			const imports = ast.program.body
				.filter((node) => node.type === 'ImportDeclaration')
				.map((node) => generate(node).code)
				.join('\n');

			const result = await esbuild.build({
				stdin: {
					contents: `${imports}${generate(schemaExport).code}`,
					loader: 'ts',
					resolveDir: dirname(path),
				},
				bundle: true,
				format: 'esm',
				write: false,
				minify: true,
				packages: 'external',
				external: ['*.astro'],
			});

			const bundledCode = result.outputFiles[0]?.text;
			if (!bundledCode) {
				logger.warn(`No output from esbuild for ${path}.`);
				continue;
			}

			const virtualId = toVirtual(VIRTUAL_MAP_ID + createHash('md5').update(path).digest('hex'));

			virtualModules.set(virtualId, { code: bundledCode, realPath: path });
			const module = await server.ssrLoadModule(virtualId);

			if (module?.schema) {
				buildAstroBlock(path, logger, module.schema);
			}
		}
	}

	return {
		name: NAME,
		resolveId(id, importer) {
			if (id === VIRTUAL_NAME_ID) return VIRTUAL_NAME;

			if (importer && importer.startsWith(VIRTUAL_MAP)) {
				const data = virtualModules.get(importer);
				return resolve(dirname(data.realPath), id);
			}
		},

		load(id) {
			if (id.startsWith(VIRTUAL_MAP)) {
				return virtualModules.get(id)?.code;
			}

			if (id === toVirtual(VIRTUAL_NAME_ID)) {
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
			handler,
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
