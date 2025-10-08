import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
import type { SchemaContext } from 'astro/content/config';
import SectionContent from './SectionContent.astro';
import { z } from 'zod';

export { SectionContent };

/**
 * Extracts the inferred TypeScript type from a section builder's Zod schema.
 *
 * @template T
 * @returns The inferred TypeScript type from the section's schema
 *
 * @example
 * ```ts
 * const section: SectionBuilder = (c: SchemaContext) => ({
 *   title: z.string(),
 *   speed: z.number()
 * });
 *
 * export type Props = PropsOf<typeof section>; // can be imported by solid/svelte/etc btw
 * const meta: Props = Astro.props;
 * ```
 */
export type PropsOf<T extends SectionBuilder> = z.infer<z.ZodObject<ReturnType<T>>>;

/**
 * @param {SchemaContext} c - The schema context
 * @returns A ZodRawShape
 */
export type SectionBuilder = (c: SchemaContext) => z.ZodRawShape;

type SectionComponent = {
	/// The filename used as a UID for the section (e.g., 'Hero'), excluding the '.astro' extension.
	type: string;

	/// The full file path to the section's Astro component
	path: string;

	/// The Zod schema builder which creates the data structure for validation.
	schema: SectionBuilder;

	/// Async factory loader for the Astro component, used to render in Content.astro.
	/// Returns a Promise<{ default: AstroComponentFactory }>.
	load: () => Promise<{ default: AstroComponentFactory }>;
};

/**
 * Internal registry mapping section identifiers to their component implementations.
 *
 * This registry is populated by {@link registerSections} and should not be modified directly.
 * Each key is a section type, and each value is the corresponding Astro component.
 *
 * @internal
 */
export const registry: Record<string, SectionComponent> = {};
export type SectionMeta = z.infer<ReturnType<typeof parseSections>>[number];

/**
 * Registers Astro section components into the global registry from globbed modules.
 *
 * @param url - Absolute base URL for resolving module locations
 * @param modules - Record of component modules containing `default` and `section` exports.
 * @example
 * The backslash in the glob pattern below is a documentation artifact to prevent parser issues.
 * ```ts
 * registerSections(
 *   import.meta.url,
 *   import.meta.glob('./components/**\/*.astro', {
 *     eager: true,
 *   }),
 * );
 * ```
 */
export function registerSections(
	url: string,
	modules: Record<string, { default: AstroComponentFactory; section: unknown }>,
) {
	Object.entries(modules).forEach(([path, module]) => {
		const schema = module.section;
		if (schema == undefined) {
			return;
		}

		// validate that the SectionBuilder is indeed a function
		if (typeof schema !== 'function') {
			console.error(
				`Invalid schema at ${path}. Defined schema is not a function: ${typeof schema}.`,
			);
			return;
		}

		// validate that what SectionBuilder returns is indeed an object
		const testSchema = schema({} as SchemaContext);
		if (typeof testSchema !== 'object' || testSchema === null) {
			console.error(
				`Invalid schema at '${path}'. Expected an object ({ ... }), but received type '${typeof testSchema}'.`,
			);
			return;
		}

		const id = path.split('/').pop()?.replace('.astro', '');
		if (id == undefined) {
			console.error('Unable to create id for path:', path);
			return;
		}

		if (registry[id] && registry[id].path != path) {
			console.warn(
				`Duplicate section ID '${id}' detected. Overwriting existing entry at '${registry[id].path}' with new entry at '${path}'.`,
			);
			return;
		}

		registry[id] = {
			type: id,
			path: path,
			// assertion should be correct enough ^o^
			// if your here because of a crash its my fault report a bug
			schema: schema as SectionBuilder,
			load: () => import(/* @vite-ignore */ new URL(path, url).href),
		};
	});
}

/**
 * Builds the most valid Zod schema for the sections defined in the registry, based on the parsed input.
 * It processes each registered section to create discriminated union schemas, filters out unknown types during preprocessing.
 *
 * @param c - The schema context, passed to each section's schema function.
 * @returns A Zod schema for an array of valid section objects, or an empty schema if no sections are registered.
 */
export function parseSections(c: SchemaContext) {
	const sections = Object.values(registry).flatMap((section) => {
		return z.object({
			type: z.literal(section.type),
			...section.schema(c),
		});
	});

	if (sections.length == 0) {
		console.warn('No sections were initialized. A empty schema will be returned.');
		return z.array(z.any());
	}

	const validTypes = new Set(sections.map((s) => s.shape.type._def.value));
	const [first, ...rest] = sections;

	return z.preprocess(
		(data: any) => {
			const warnings: string[] = [];

			// filters out any duplicate types
			const filtered = data.filter((section: any) => {
				if (section?.type && !validTypes.has(section.type)) {
					warnings.push(section.type);
					return false;
				}

				return true;
			});

			console.warn(
				`Unknown section types were parsed: ${warnings.join(', ')}. They will not show.`,
			);

			return filtered;
		},

		z.array(z.discriminatedUnion('type', [first!, ...rest!])),
	);
}
