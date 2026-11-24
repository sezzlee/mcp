import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { SezzleePdfError } from "../platform/errors.js";
import type { OcrBinding, PageImageBinding } from "./port.js";

function hasMethod(value: unknown, name: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === "function"
  );
}

/**
 * Guard: the module is checked for the two methods the orchestrator calls and
 * for a provider name, before any document is opened. A binding that is missing
 * one of them would otherwise fail on the first scanned page, after the caller
 * already paid for the extraction.
 */
export function asOcrBinding(value: unknown, specifier: string): OcrBinding {
  const binding = value as Partial<OcrBinding> | undefined;
  const rasterizer = binding?.rasterizer;
  const provider = binding?.provider;
  if (!hasMethod(rasterizer, "render") || !hasMethod(provider, "recognize")) {
    throw new SezzleePdfError(
      "invalid_argument",
      `'${specifier}' does not export an OCR binding.`,
      "The module's default export must be { rasterizer: { render }, provider: { name, recognize } }.",
    );
  }
  if (typeof provider?.name !== "string" || provider.name === "") {
    throw new SezzleePdfError(
      "invalid_argument",
      `The OCR provider from '${specifier}' has no name.`,
      "Name the provider so describe_document can report which one is bound.",
    );
  }
  return binding as OcrBinding;
}

/**
 * Loads an OCR binding the operator pointed at.
 *
 * Guard: this server names no provider and no rasterizer. It loads what the
 * command line asks for, which is what keeps the choice — and the decision to
 * let page images leave this machine — with whoever runs the server.
 */
export async function loadOcrBinding(specifier: string): Promise<OcrBinding> {
  return asOcrBinding(await loadBinding(specifier, "OCR"), specifier);
}

export async function loadPageImageBinding(
  specifier: string,
): Promise<PageImageBinding> {
  const binding = (await loadBinding(specifier, "page-image")) as
    Partial<PageImageBinding> | undefined;
  if (!hasMethod(binding?.rasterizer, "render")) {
    throw new SezzleePdfError(
      "invalid_argument",
      `'${specifier}' does not export a page-image binding.`,
      "The module's default export must be { rasterizer: { render } } with optional rendering bounds.",
    );
  }
  return binding as PageImageBinding;
}

async function loadBinding(specifier: string, label: string): Promise<unknown> {
  const target =
    specifier.startsWith(".") || isAbsolute(specifier)
      ? pathToFileURL(resolve(specifier)).href
      : specifier;
  try {
    const module = (await import(target)) as { default?: unknown };
    return module.default;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SezzleePdfError(
      "invalid_argument",
      `The ${label} binding '${specifier}' could not be loaded: ${detail}`,
      "Pass a path to a module, or a package name resolvable from this process.",
    );
  }
}
