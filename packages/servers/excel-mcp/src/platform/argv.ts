export type ExcelArgv =
  | { readonly kind: "read"; readonly path: string }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly directory: string;
    }
  | { readonly kind: "usage" };

export function parseExcelArgv(argv: readonly string[]): ExcelArgv {
  const [, , root, ...rest] = argv;
  if (root === undefined || root === "" || root.startsWith("-"))
    return { kind: "usage" };
  if (rest.length === 0) return { kind: "read", path: root };
  const [flag, directory] = rest;
  if (
    rest.length !== 2 ||
    flag !== "--write" ||
    directory === undefined ||
    directory === "" ||
    directory.startsWith("-")
  )
    return { kind: "usage" };
  return { kind: "write", path: root, directory };
}
