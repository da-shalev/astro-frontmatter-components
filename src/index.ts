import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
import type { SchemaContext } from 'astro/content/config';
import Frontmatter from './Frontmatter.astro';
import { z } from 'zod';

export { Frontmatter };

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

	/// Async factory loader for the Astro component, used for HMR rendering at SectionContent.astro.
	load: { default: AstroComponentFactory };
};

/**
 * Registers Astro schema components into the global registry from globbed modules.
 *
 * @param modules Record of component modules containing `default` and `schema` exports.
 * @returns Collection of the registered Astro components
 *
 */
export function registerAstroComponents(
	modules: Record<string, { default: AstroComponentFactory; schema: unknown }>,
): SchemaRegistry {
	const registry: SchemaRegistry = {};

	Object.entries(modules).map(([path, module]) => {
		const { default: component, schema } = module;

		// it's a regular Astro component
		if (schema == undefined) {
			return;
		}

		// ensure schema is a valid function
		if (typeof schema !== 'function') {
			console.error(
				`Invalid schema at ${path}. Defined schema is not a function: ${typeof schema}.`,
			);
			return;
		}

		// builds the schema early to validate that it's being good
		const testSchema = schema({} as SchemaContext);

		// ensure schema returns a a valid object
		if (testSchema === null || typeof testSchema !== 'object') {
			console.error(
				`Invalid schema at '${path}'. Expected a raw object ({ ... }), but received type '${typeof testSchema}'.`,
			);
			return;
		}

		// ensure schema returns a z.ZodRawShape not a z.ZodObject
		if (testSchema.shape != null) {
			console.error(
				`Invalid schema at '${path}'. Expected a raw object ({ ... }), but received a z.object()`,
			);
			return;
		}

		const type = path.split('/').pop()?.replace('.astro', '');
		if (type == undefined) {
			console.error('Unable to create id for path:', path);
			return;
		}

		if (registry[type] && registry[type].path != path) {
			console.warn(
				`Duplicate block ID '${type}' detected. Ignoring new entry at '${path}' and keeping existing entry at '${registry[type].path}'.`,
			);
			return;
		}

		registry[type] = {
			type,
			path,
			schema: schema as SchemaBuilder,
			load: { default: component },
		};
	});

	return registry;
}

/**
 * Parses an array of blocks using the registered block types, rejecting any unknown ones.
 *
 * @param c - SchemaContext needed for resolving paths of images.
 */
export function parseBlocks(c: SchemaContext, registry: SchemaRegistry) {
	const blocks = Object.values(registry).flatMap((block) => {
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

			console.warn(`Unknown block types were parsed: ${warnings.join(', ')}. They will not show.`);

			return filtered;
		},

		z.array(z.discriminatedUnion('type', [first!, ...rest!])),
	);
}
