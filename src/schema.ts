import type { SchemaContext } from 'astro/content/config';
import { z } from 'zod';
import { getRegistry, type SchemaRegistry } from './integration';

// export function queryBlocks<T extends SchemaBuilder>(
// 	blocks: SchemaMeta[] | undefined | never[],
// 	schema: T,
// ): (SchemaOf<T> & SchemaMeta)[] {
// 	if (!blocks || blocks.length === 0) {
// 		return [];
// 	}
//
// 	return blocks.filter(
// 		(block): block is SchemaOf<T> & SchemaMeta => block.type === entry.type,
// 	) as (SchemaOf<T> & SchemaMeta)[];
// }

/**
 * Extracts the inferred TypeScript type from a schema builder's Zod schema.
 *
 * @template T
 * @returns The inferred TypeScript type from the block's schema
 */
export type SchemaOf<T extends SchemaBuilder> = z.infer<z.ZodObject<ReturnType<T>>>;

/**
 * A function that builds a Zod schema shape for a specific context.
 */
export interface SchemaBuilder {
	(c: SchemaContext): z.ZodRawShape;
	_registryId: symbol;
}

export function createSchema<T extends z.ZodRawShape>(
	builder: (c: SchemaContext) => T,
): SchemaBuilder {
	return Object.assign(builder, {
		_registryId: getRegistry().id,
	});
}

export function isSchemaBuilder(
	schema: unknown,
	registry: SchemaRegistry,
): schema is SchemaBuilder {
	return (
		typeof schema === 'function' && '_registryId' in schema && schema._registryId === registry.id
	);
}

export function getType(path: string): string | undefined {
	return path.split('/').pop()?.replace('.astro', '');
}
