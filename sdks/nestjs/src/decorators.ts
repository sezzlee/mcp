import type {
  ArgumentFill,
  EndpointDescriptor,
  JsonSchemaObject,
} from "@sezzlee/core";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A curation rule for one argument.
 *
 * The union is what makes "hidden but also renamed" unrepresentable: a hidden argument has no
 * agent-facing name or description to carry.
 */
export type ArgumentRule =
  | {
      readonly hide?: undefined;
      readonly as?: string;
      readonly description?: string;
    }
  | { readonly hide: ArgumentFill };

export const hidden = {
  value: (value: JsonValue): ArgumentRule => ({
    hide: { kind: "constant", value },
  }),
  from: (source: string): ArgumentRule => ({
    hide: { kind: "deferred", source },
  }),
  omit: (): ArgumentRule => ({ hide: { kind: "omit" } }),
} as const;

export type ArgumentRules<T> = {
  readonly [K in keyof T & string]?: ArgumentRule;
};

/**
 * Key-checks a curation against a DTO's own keys.
 *
 * Optional: `arguments` accepts a plain record. Reaching for this moves the
 * `curation_unresolved` diagnostic from startup to compile time, which is where a typo belongs.
 */
export function curate<T>(rules: ArgumentRules<T>): ArgumentRules<T> {
  return rules;
}

type DescriptorParameter = NonNullable<
  EndpointDescriptor["parameters"]
>[number];

export interface McpParameterOptions {
  readonly required?: boolean;
  readonly style?: DescriptorParameter["style"];
  readonly explode?: boolean;
}

/**
 * What one status code returns.
 *
 * A bare class is bound through the same TypeShape reader the request body uses; a one-element
 * tuple declares a collection of it; `{ schema }` supplies a schema verbatim; `{}` declares a
 * status that carries no body.
 */
export type McpResponseDeclaration =
  | NewableFunction
  | readonly [NewableFunction]
  | { readonly schema: JsonSchemaObject }
  | Record<string, never>;

export interface McpFileFieldOptions {
  /** A `FilesInterceptor` field, sent as repeated parts. */
  readonly multiple?: boolean;
  readonly required?: boolean;
  readonly description?: string;
  /** The media type the backend expects; it becomes the part's default. */
  readonly mediaType?: string;
}

export interface McpToolOptions {
  readonly name?: string;
  readonly prefix?: string;
  readonly description?: string;
  readonly body?: JsonSchemaObject;
  /**
   * What the endpoint returns, keyed by status code.
   *
   * A declaration is needed because a handler's return type is not readable at runtime: TypeScript
   * emits `design:returntype` with the generic erased, so an `async` handler reports `Promise` and
   * a collection reports `Array`. Discovery falls back to `@nestjs/swagger`'s response metadata and
   * then to `design:returntype`, but only a declaration here is guaranteed to be exact.
   */
  readonly responses?: Readonly<Record<string, McpResponseDeclaration>>;
  /**
   * Whether the backend requires a body at all, as distinct from requiring the
   * fields inside it. `false` makes omitting the body expressible: the agent
   * then sends no body rather than an empty object.
   */
  readonly bodyRequired?: boolean;
  /**
   * Per-parameter declarations keyed by parameter name. Nest exposes no runtime
   * signal that proves a named `@Query`/`@Headers` is required, nor how an
   * array-valued one is serialised, so both are declarations rather than
   * inferences.
   */
  readonly parameters?: Readonly<Record<string, McpParameterOptions>>;
  /**
   * Curation declarations keyed by wire name: a parameter, a flattened body field, or the body
   * root argument. Distinct from `parameters`, which corrects a discovered fact; these declare the
   * agent-facing surface and span the body too.
   */
  readonly arguments?: Readonly<Record<string, ArgumentRule>>;
  /**
   * The operation's grouping labels, replacing the one derived from the container rather than
   * adding to it, so a host can remove a grouping it did not choose. They are `search_tools`
   * filter keys and search index vocabulary at once ([search-semantics.md]).
   */
  readonly tags?: readonly string[];
  /**
   * Search vocabulary the operation's own text does not contain. Indexed like the description,
   * never a filter key and never shown to the agent ([search-semantics.md]).
   */
  readonly searchTerms?: readonly string[];
  /**
   * The behaviour revision at the level the decorator sits on: a method's covers that operation,
   * a controller's every operation in it. Raised when behaviour changes behind an unchanged
   * schema, it changes the tool version and nothing the agent reads ([metadata-contract.md]).
   * The two levels never replace one another.
   */
  readonly revision?: number;
  /**
   * The body's media type, replacing the one discovery chooses. It is the host's own claim that a
   * parser for it is registered; when `@ApiConsumes` also lists types, it must be one of them.
   */
  readonly consumes?: string;
  /**
   * The multipart file fields, keyed by the name the file interceptor reads. `FileInterceptor`
   * keeps that name in a closure, so without a declaration here or an `@ApiBody` schema marking
   * the field `format: "binary"` the endpoint is dropped rather than guessed at.
   */
  readonly files?: Readonly<Record<string, McpFileFieldOptions>>;
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly variants?: readonly McpVariantOptions[];
  readonly family?: McpToolFamilyOptions;
}

/**
 * The operation dispatches on one parameter, and each of its variants is a member that writes its
 * own key there ([tool-families.md]).
 *
 * @param parameter the dispatch parameter's wire name
 * @param source the name a member source was registered under with `options.families.provide`;
 * without one the members are the handler's `@McpVariant`s alone
 */
export interface McpToolFamilyOptions {
  readonly parameter: string;
  readonly source?: string;
}

/**
 * Behaviour hints a member declares. The union keeps a read-only member from also claiming to be
 * destructive, which MCP defines as meaningless.
 */
export type McpToolEffect =
  | {
      readonly readOnly: true;
      readonly destructive?: never;
      readonly idempotent?: boolean;
    }
  | {
      readonly readOnly?: false;
      readonly destructive?: boolean;
      readonly idempotent?: boolean;
    };

/**
 * One of several tools produced from a single operation.
 *
 * `name` and `description` are non-optional because one description cannot honestly describe two
 * tools whose arguments are hidden differently; `tsc` therefore enforces the rule at the
 * declaration site.
 */
export interface McpVariantOptions {
  readonly name: string;
  readonly description: string;
  readonly arguments?: Readonly<Record<string, ArgumentRule>>;
  /** A family member's own body; refused on a variant of an operation that is not a family. */
  readonly body?: JsonSchemaObject;
  readonly bodyRequired?: boolean;
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
}

export interface McpSelectionMarker {
  readonly include: boolean;
  readonly options: McpToolOptions;
}

export const MCP_SELECTION = "sezzlee:selection";

export function McpVariant(options: McpVariantOptions): MethodDecorator {
  return ((
    _target: object,
    _property?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    if (descriptor?.value !== undefined) {
      appendVariant(descriptor.value as object, options);
    }
  }) as MethodDecorator;
}

export function McpToolFamily(options: McpToolFamilyOptions): MethodDecorator {
  return ((
    _target: object,
    _property?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    if (descriptor?.value !== undefined) {
      updateCarrier(descriptor.value as object, (carried) => ({
        ...carried,
        family: options,
      }));
    }
  }) as MethodDecorator;
}

type Target = object | ((...args: never[]) => unknown);

function append(target: Target, marker: McpSelectionMarker): void {
  const existing =
    (Reflect.getOwnMetadata(MCP_SELECTION, target) as
      McpSelectionMarker[] | undefined) ?? [];
  Reflect.defineMetadata(MCP_SELECTION, [...existing, marker], target);
}

function appendVariant(target: object, variant: McpVariantOptions): void {
  /**
   * Prepended, not appended: method decorators evaluate bottom-up, so appending would publish the
   * variants in the reverse of the order they are written in, and the order is what the catalog
   * zips names against.
   */
  updateCarrier(target, (carried) => ({
    ...carried,
    variants: [variant, ...(carried.variants ?? [])],
  }));
}

function updateCarrier(
  target: object,
  update: (carried: McpToolOptions) => McpToolOptions,
): void {
  const existing =
    (Reflect.getOwnMetadata(MCP_SELECTION, target) as
      McpSelectionMarker[] | undefined) ?? [];
  const carrier = existing.find((marker) => marker.include);
  const marker: McpSelectionMarker = {
    include: true,
    options: update(carrier?.options ?? {}),
  };
  Reflect.defineMetadata(
    MCP_SELECTION,
    carrier === undefined
      ? [...existing, marker]
      : existing.map((entry) => (entry === carrier ? marker : entry)),
    target,
  );
}

function decorate(
  marker: McpSelectionMarker,
): ClassDecorator & MethodDecorator {
  return ((
    target: Target,
    _property?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    append(descriptor?.value !== undefined ? descriptor.value : target, marker);
  }) as ClassDecorator & MethodDecorator;
}

export function McpTool(
  options: McpToolOptions = {},
): ClassDecorator & MethodDecorator {
  return decorate({ include: true, options });
}

export function McpIgnore(): ClassDecorator & MethodDecorator {
  return decorate({ include: false, options: {} });
}

export function markersOf(target: Target | undefined): McpSelectionMarker[] {
  if (target === undefined) {
    return [];
  }
  return (
    (Reflect.getOwnMetadata(MCP_SELECTION, target) as
      McpSelectionMarker[] | undefined) ?? []
  );
}
