import type { SchemaContext } from 'astro/content/config';
import type { SchemaMeta, SchemaRegistry } from './integration';
import { z } from 'zod';
import { getRegistry } from './integration';

export const sanitizeType = (str: string) =>
	str.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^[0-9]/, '_$&');

export function queryBlocks<T extends SchemaBuilder>(
	blocks: SchemaMeta[] | undefined | never[],
	schema: T,
): SchemaOf<T>[] {
	return (blocks ?? []).filter(
		(block): block is SchemaOf<T> => block.type === schema.type,
	);
}

/**
 * Extracts the inferred TypeScript type from a schema builder's Zod schema.
 *
 * @template T
 * @returns The inferred TypeScript type from the block's schema
 */
export type SchemaOf<T extends SchemaBuilder> = z.infer<ReturnType<T>>;

/**
 * A function that builds a Zod schema for a specific context.
 */
export interface SchemaBuilder<T extends z.AnyZodObject = z.AnyZodObject> {
	(c: SchemaContext): T;
	type: string;
	_registryId: symbol;
}

export function createSchema<T extends z.AnyZodObject>(
	type: string,
	builder: (c: SchemaContext) => T,
): SchemaBuilder<T> {
	const result = builder as SchemaBuilder<T>;
	result.type = sanitizeType(type);
	result._registryId = getRegistry().id;
	return result;
}

export function isSchemaBuilder(schema: any, registry: SchemaRegistry): schema is SchemaBuilder {
	return (
		typeof schema === 'function' && '_registryId' in schema && schema._registryId === registry.id
	);
}
