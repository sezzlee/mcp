import { Anchor, Box, Stack, Text } from "@mantine/core";
import type { DocHeading } from "../lib/content";

export function OnThisPage({
  headings,
}: Readonly<{ headings: readonly DocHeading[] }>) {
  return (
    <Box
      component="nav"
      aria-labelledby="on-this-page"
      pos="sticky"
      top={96}
      visibleFrom="lg"
      w={220}
      className="shrink-0 self-start"
    >
      <Text
        id="on-this-page"
        ff="monospace"
        fz={11}
        c="dimmed"
        tt="uppercase"
        mb="sm"
        className="tracking-[0.08em]"
      >
        On this page
      </Text>
      <Stack gap={6} component="ul" className="m-0 list-none p-0">
        {headings.map((heading) => (
          <li key={heading.id}>
            <Anchor
              href={`#${heading.id}`}
              c="dimmed"
              fz="sm"
              underline="never"
              pl={heading.depth === 3 ? "sm" : 0}
              className="block leading-snug hover:text-(--mantine-color-text)"
            >
              {heading.text}
            </Anchor>
          </li>
        ))}
      </Stack>
    </Box>
  );
}
