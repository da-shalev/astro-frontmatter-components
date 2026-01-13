import type { AstroIntegration, AstroIntegrationLogger } from 'astro';
import type { Plugin, ViteDevServer } from 'vite';
import type { SchemaContext } from 'astro:content';
import { isSchemaBuilder, type SchemaBuilder } from './schema';
import fs from 'fs/promises';

import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { z } from 'zod';
import { glob } from 'tinyglobby';

import { parse } from '@babel/parser';
import { parse as parseastro } from '@astrojs/compiler';
import { generate } from '@babel/generator';
import type * as babel from '@babel/types';
import esbuild from 'esbuild';

export type SchemaComponent = {
	/// The filename used as a UID for the schemas (e.g., 'Hero'), excluding the '.astro' extension.
	type: string;

	/// The relative path to the schemas's Astro component
	path: string;

	/// The Zod schema builder which creates the data structure for validation.
	schema: SchemaBuilder;
};

export type SchemaModule = {
	code: string;
	realPath: string;
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

function constructSchema(path: string, logger: AstroIntegrationLogger, schema?: unknown) {
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

const toVirtual = (id: string) => `\0${id}`;

const NAME: string = 'astro-frontmatter-cms';
const VIRTUAL_NAME_ID: string = `virtual:${NAME}`;
const VIRTUAL_MAP_ID: string = `${VIRTUAL_NAME_ID}:`;
const VIRTUAL_MAP: string = toVirtual(VIRTUAL_MAP_ID);
const VIRTUAL_NAME: string = toVirtual(VIRTUAL_NAME_ID);
const REQUIRED_EXPORTS = ['schema'];
const OPTIONAL_EXPORTS = ['seo'];

export function frontmatterComponents(): AstroIntegration {
	const virtualModules = new Map<string, SchemaModule>();

	function serve(logger: AstroIntegrationLogger, srcDir: string): Plugin {
		return {
			name: 'frontmatter-cms-resolver',
			enforce: 'post',
			resolveId(id, importer) {
				if (id === VIRTUAL_NAME_ID) return VIRTUAL_NAME;
				if (importer?.startsWith(VIRTUAL_MAP)) return virtualModules.get(importer)?.realPath;
			},

			load(id) {
				if (id.startsWith(VIRTUAL_MAP)) return virtualModules.get(id)?.code;
				if (id === VIRTUAL_NAME) {
					const blocks = Object.values(getRegistry().components);
					return [
						...blocks.map((b) => `import ${b.type} from '${b.path}';`),
						'export default {',
						...blocks.map((b) => `'${b.type}': ${b.type},`),
						'};',
					].join('\n');
				}
			},
			configureServer: async function (server) {
				for (const file of await glob('**/*.astro', {
					cwd: srcDir,
					absolute: true,
				})) {
					await resolve(file, server, logger);
				}
			},
		};
	}

	async function resolve(realPath: string, server: ViteDevServer, logger: AstroIntegrationLogger) {
		const file = await fs.readFile(realPath, 'utf-8');
		const frontmatter = (await parseastro(file)).ast.children?.find(
			(node) => node.type === 'frontmatter',
		)?.value;

		if (!frontmatter) {
			logger.warn(`No frontmatter found in ${realPath}.`);
			return;
		}

		const ast = parse(frontmatter, {
			sourceType: 'module',
			plugins: ['typescript', 'jsx'],
			ranges: true,
			errorRecovery: true,
		});

		if (ast.errors && ast.errors.length > 0) {
			return;
		}

		const getExportNames = (node: babel.Statement) =>
			node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration'
				? node.declaration.declarations.flatMap((decl) =>
						decl.id.type === 'Identifier' ? [decl.id.name] : [],
					)
				: [];

		const exports = ast.program.body.filter((node) =>
			getExportNames(node).some((name) =>
				[...REQUIRED_EXPORTS, ...OPTIONAL_EXPORTS].includes(name),
			),
		);

		const requiredExports = REQUIRED_EXPORTS.filter(
			(exp) => !exports.flatMap(getExportNames).includes(exp),
		);

		if (requiredExports.length > 0) {
			return;
		}

		const result = await esbuild.build({
			stdin: {
				contents: [
					...ast.program.body.filter((node) => node.type === 'ImportDeclaration'),
					...exports,
				]
					.map((node) => generate(node).code)
					.join('\n'),
				loader: 'ts',
				resolveDir: dirname(realPath),
			},
			bundle: true,
			format: 'esm',
			write: false,
			minify: true,
			packages: 'external',
			external: ['*.astro'],
		});

		const code = result.outputFiles[0]?.text;
		if (!code) {
			logger.warn(`No output from esbuild for ${realPath}.`);
			return;
		}

		// runs code using vite resolving all dependences needed only for schema
		const virtualId = toVirtual(VIRTUAL_MAP_ID + createHash('md5').update(realPath).digest('hex'));

		virtualModules.set(virtualId, { code, realPath });
		const module = await server.ssrLoadModule(virtualId);

		if (module?.schema) {
			constructSchema(realPath, logger, module.schema);
		}
	}

	return {
		name: NAME,

		hooks: {
			'astro:config:setup': async ({ logger, updateConfig, config }) => {
				updateConfig({
					vite: {
						plugins: [serve(logger, fileURLToPath(config.srcDir))],
					},
				});
			},
		},
	};
}
