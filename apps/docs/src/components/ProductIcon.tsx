import {
  IconApi,
  IconBox,
  IconCpu,
  IconDatabase,
  IconFileCode,
  IconFileText,
  IconTable,
  type Icon,
} from "@tabler/icons-react";

const ICONS: Readonly<Record<string, Icon>> = {
  "excel-mcp": IconTable,
  "pdf-mcp": IconFileText,
  "mssql-mcp": IconDatabase,
  "postgres-mcp": IconDatabase,
  "xml-mcp": IconFileCode,
  "http-catalog": IconApi,
  "llm-mcp": IconCpu,
};

export function ProductIcon({
  product,
  size,
}: Readonly<{ product: string; size: number }>) {
  const Glyph = ICONS[product] ?? IconBox;
  return <Glyph size={size} stroke={1.5} aria-hidden />;
}
