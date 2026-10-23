import { SezzleeCatalogError, SezzleeTemplateError } from "./errors.js";
import { assertFamily, productionDescriptor } from "./family.js";
import type {
  EndpointDescriptor,
  ToolVariant,
} from "./generated/endpoint-descriptor.js";

export const longNameThreshold = 64;

const toolNamePattern = /^[a-z][a-z0-9_]{0,255}$/;

const isAsciiUpper = (c: string): boolean => c >= "A" && c <= "Z";
const isAsciiLower = (c: string): boolean => c >= "a" && c <= "z";
const isAsciiDigit = (c: string): boolean => c >= "0" && c <= "9";

function collapse(value: string): string {
  return value.replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export function snakeCase(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index] as string;
    if (isAsciiUpper(character)) {
      const previous = index > 0 ? (value[index - 1] as string) : "";
      const next = index + 1 < value.length ? (value[index + 1] as string) : "";
      const afterLowercase = previous !== "" && isAsciiLower(previous);
      const acronymEnd =
        previous !== "" &&
        isAsciiUpper(previous) &&
        next !== "" &&
        isAsciiLower(next);
      if (out.length > 0 && (afterLowercase || acronymEnd)) {
        out += "_";
      }
      out += character.toLowerCase();
    } else if (isAsciiLower(character) || isAsciiDigit(character)) {
      out += character;
    } else {
      out += "_";
    }
  }
  return collapse(out);
}

function placeholderName(placeholder: string): string {
  const name = placeholder.replace(/^\*+/, "");
  const constraint = name.search(/[:?=]/);
  return constraint >= 0 ? name.slice(0, constraint) : name;
}

function fromRoute(endpoint: EndpointDescriptor): string {
  const parts = [endpoint.method.toLowerCase()];
  const pathParameters: string[] = [];
  for (const segment of endpoint.route.split("/").filter((s) => s.length > 0)) {
    if (segment.startsWith("{") && segment.endsWith("}")) {
      pathParameters.push(
        "by_" + snakeCase(placeholderName(segment.slice(1, -1))),
      );
    } else {
      parts.push(snakeCase(segment));
    }
  }
  return collapse([...parts, ...pathParameters].join("_"));
}

export type PrefixMode = "always" | "onCollision";

const controllerSuffix = "Controller";

function fold(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function tokensOf(name: string): string[] {
  return name
    .split("_")
    .filter((part) => part.length > 0)
    .map(fold);
}

export function derivePrefix(endpoint: EndpointDescriptor): string | undefined {
  if (endpoint.containerPrefix !== undefined) {
    return snakeCase(endpoint.containerPrefix);
  }
  const container = endpoint.container;
  if (container === undefined || container.trim() === "") {
    return undefined;
  }
  const segments = container.split(".").filter((part) => part.length > 0);
  let last = segments[segments.length - 1] ?? "";
  if (
    last.length > controllerSuffix.length &&
    last.endsWith(controllerSuffix)
  ) {
    last = last.slice(0, -controllerSuffix.length);
  }
  const prefix = snakeCase(last);
  return prefix === "" ? undefined : prefix;
}

function isRedundant(prefix: string, body: string): boolean {
  const prefixTokens = tokensOf(prefix);
  const bodyTokens = tokensOf(body);
  if (prefixTokens.length === 0 || prefixTokens.length > bodyTokens.length) {
    return false;
  }
  for (
    let start = 0;
    start + prefixTokens.length <= bodyTokens.length;
    start++
  ) {
    if (
      prefixTokens.every(
        (token, offset) => bodyTokens[start + offset] === token,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function applyPrefix(body: string, prefix: string | undefined): string {
  if (prefix === undefined || prefix === "" || isRedundant(prefix, body)) {
    return body;
  }
  return collapse(`${prefix}_${body}`);
}

function validate(name: string, endpoint: EndpointDescriptor): string {
  if (!toolNamePattern.test(name)) {
    throw new SezzleeCatalogError(
      "invalid_name",
      `Generated tool name '${name}' for ${endpoint.method} ${endpoint.route} does not match the required pattern; define an operationId or a tool name.`,
    );
  }
  return name;
}

function validateVariant(
  variant: ToolVariant,
  operation: EndpointDescriptor,
): string {
  if (!toolNamePattern.test(variant.name)) {
    throw new SezzleeCatalogError(
      "invalid_name",
      `Variant name '${variant.name}' of ${operation.method} ${operation.route} does not match the required pattern.`,
    );
  }
  return variant.name;
}

export function createToolBody(endpoint: EndpointDescriptor): string {
  return endpoint.operationId === undefined ||
    endpoint.operationId.trim() === ""
    ? fromRoute(endpoint)
    : snakeCase(endpoint.operationId);
}

export function createToolName(
  endpoint: EndpointDescriptor,
  mode: PrefixMode = "always",
): string {
  if (endpoint.toolName !== undefined) {
    return validate(endpoint.toolName, endpoint);
  }
  const body = createToolBody(endpoint);
  const name =
    mode === "always" ? applyPrefix(body, derivePrefix(endpoint)) : body;
  return validate(name, endpoint);
}

function shorter(candidate: string, current: string): boolean {
  if (candidate.length !== current.length) {
    return candidate.length < current.length;
  }
  return candidate < current;
}

export interface FoldedOperation<T> {
  readonly kept: T;
  readonly folded: readonly T[];
}

/**
 * Guard: a declared full name is part of an operation's identity. A generator that writes the
 * handler's method name as `operationId` gives two controllers' `list` the same one, and folding
 * them would leave one of the two tools unpublished, invoking the other's route.
 */
export function deduplicateOperations<T>(
  items: readonly T[],
  selector: (item: T) => EndpointDescriptor,
  onFolded?: (fold: FoldedOperation<T>) => void,
): T[] {
  const operations: T[] = [];
  const seen = new Map<string, number>();
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const endpoint = selector(item);
    if (
      endpoint.operationId === undefined ||
      endpoint.operationId.trim() === ""
    ) {
      operations.push(item);
      continue;
    }
    const key = JSON.stringify([
      endpoint.container ?? "",
      endpoint.operationId,
      endpoint.method.toUpperCase(),
      endpoint.toolName ?? "",
    ]);
    const members = grouped.get(key);
    if (members === undefined) {
      grouped.set(key, [item]);
    } else {
      members.push(item);
    }
    const index = seen.get(key);
    if (index === undefined) {
      seen.set(key, operations.length);
      operations.push(item);
      continue;
    }
    if (shorter(endpoint.route, selector(operations[index] as T).route)) {
      operations[index] = item;
    }
  }
  if (onFolded !== undefined) {
    for (const [key, members] of grouped) {
      if (members.length < 2) {
        continue;
      }
      const kept = operations[seen.get(key) as number] as T;
      onFolded({ kept, folded: members.filter((member) => member !== kept) });
    }
  }
  return operations;
}

export interface NamingOptions {
  readonly prefixMode?: PrefixMode;
  readonly onDiagnostic?: (code: string, message: string) => void;
}

/**
 * One tool to produce.
 *
 * @param operation the declared operation: its identity folds routes, owns diagnostics and keys the
 * catalog's source lookup
 * @param endpoint the descriptor the tool and its template are built from; for a family member it
 * carries the member's body instead of the operation's
 */
export interface ToolProduction {
  readonly operation: EndpointDescriptor;
  readonly endpoint: EndpointDescriptor;
  readonly variant?: ToolVariant;
}

/**
 * Folds routes first, then expands variants.
 *
 * The order is what keeps {@link deduplicateOperations} unchanged: it never
 * sees a variant, so its grouping key stays the operation identity. It is also
 * the single place productions are enumerated — naming used to fold internally
 * while the catalog folded again, which is idempotent for plain operations and
 * is not for variants, where a second fold would return fewer names than tools
 * and misalign the catalog's positional zip.
 */
export function expandToolProductions<T>(
  items: readonly T[],
  selector: (item: T) => EndpointDescriptor,
  onFolded?: (fold: FoldedOperation<T>) => void,
): ToolProduction[] {
  return deduplicateOperations(items, selector, onFolded).flatMap((item) =>
    productionsOf(selector(item)),
  );
}

/**
 * The productions of one already-folded operation.
 *
 * @throws SezzleeTemplateError when the operation's variant or family declaration is refused; the
 * refusal concerns this operation alone
 */
export function productionsOf(operation: EndpointDescriptor): ToolProduction[] {
  if (operation.variants === undefined) {
    assertFamily(operation);
    return [{ operation, endpoint: operation }];
  }
  if (operation.toolName !== undefined) {
    throw new SezzleeTemplateError(
      "variant_declaration_conflict",
      `${operation.method} ${operation.route} declares both a tool name and variants; a variant names itself.`,
    );
  }
  assertFamily(operation);
  return operation.variants.map((variant) => ({
    operation,
    endpoint: productionDescriptor(operation, variant),
    variant,
  }));
}

export function createToolNames(
  endpoints: readonly EndpointDescriptor[],
  options: NamingOptions = {},
): string[] {
  return nameProductions(
    expandToolProductions(endpoints, (e) => e),
    options,
  );
}

/**
 * Names already-expanded productions, one name per production in order.
 *
 * @throws SezzleeCatalogError `invalid_name` or `name_collision`; both concern the catalog as a
 * whole, because a name is only valid relative to every other name
 */
export function nameProductions(
  productions: readonly ToolProduction[],
  options: NamingOptions = {},
): string[] {
  const mode = options.prefixMode ?? "always";
  const names = productions.map(({ operation, variant }) =>
    variant === undefined
      ? createToolName(operation, mode)
      : validateVariant(variant, operation),
  );

  if (mode === "onCollision") {
    const groups = new Map<string, number[]>();
    productions.forEach(({ operation, variant }, index) => {
      if (operation.toolName !== undefined || variant !== undefined) {
        return;
      }
      const group = groups.get(names[index] as string);
      if (group === undefined) {
        groups.set(names[index] as string, [index]);
      } else {
        group.push(index);
      }
    });
    for (const [body, group] of groups) {
      if (group.length < 2) {
        continue;
      }
      for (const index of group) {
        const operation = (productions[index] as ToolProduction).operation;
        const prefixed = applyPrefix(body, derivePrefix(operation));
        if (prefixed === body) {
          continue;
        }
        names[index] = prefixed;
        options.onDiagnostic?.(
          "name_disambiguated",
          `Tool name '${body}' collided; ${operation.method} ${operation.route} is exposed as '${prefixed}'.`,
        );
      }
    }
  }

  const claimed = new Map<string, EndpointDescriptor>();
  productions.forEach(({ operation }, index) => {
    const name = names[index] as string;
    const owner = claimed.get(name);
    if (owner !== undefined) {
      throw new SezzleeCatalogError(
        "name_collision",
        `Tool name '${name}' is produced by both ${owner.method} ${owner.route} and ${operation.method} ${operation.route}; declare a tool name on one of them.`,
      );
    }
    claimed.set(name, operation);
  });
  return names;
}
