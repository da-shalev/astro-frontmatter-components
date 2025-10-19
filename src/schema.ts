import type { SchemaContext } from 'astro/content/config';
import type { SchemaMeta, SchemaRegistry } from './integration';
import { z } from 'zod';
import { getRegistry } from './integration';

export const sanitizeType = (str: string) =>
	str.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^[0-9]/, '_$&');

export function queryBlocks<T extends SchemaBuilder>(
	blocks: SchemaMeta[] | undefined | never[],
	schema: T,
): (SchemaOf<T> & SchemaMeta)[] {
	if (!blocks || blocks.length === 0) {
		return [];
	}

	return blocks.filter(
		(block): block is SchemaOf<T> & SchemaMeta => block.type === schema.type,
	) as (SchemaOf<T> & SchemaMeta)[];
}

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
	type: string;
	_registryId: symbol;
}

export function createSchema<T extends z.ZodRawShape>(
	type: string,
	builder: (c: SchemaContext) => T,
): SchemaBuilder & ((c: SchemaContext) => T) {
	return Object.assign(builder, {
		type: sanitizeType(type),
		_registryId: getRegistry().id,
	});
}

export function isSchemaBuilder(schema: any, registry: SchemaRegistry): schema is SchemaBuilder {
	return (
		typeof schema === 'function' && '_registryId' in schema && schema._registryId === registry.id
	);
}
