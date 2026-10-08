import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Anchor, Badge, Box, Container, Group, Text } from "@mantine/core";
import { IconArrowUpRight } from "@tabler/icons-react";
import { SITE_LINKS } from "../lib/site";
import { BrandMark } from "./BrandMark";
import { ColorSchemeToggle } from "./ColorSchemeToggle";
import { SearchButton } from "./DocsSearch";

export function SiteHeader({
  leading,
  width,
}: Readonly<{ leading: ReactNode; width: "full" | "contained" }>) {
  return (
    <Container
      size={width === "contained" ? 1280 : "100%"}
      px="lg"
      h="100%"
      w="100%"
    >
      <Group h="100%" justify="space-between" wrap="nowrap" gap="md">
        <Group gap="sm" wrap="nowrap">
          {leading}
          <Anchor
            component={Link}
            to="/"
            underline="never"
            c="inherit"
            className="flex items-center gap-2.5"
          >
            <BrandMark size={28} />
            <Text ff="heading" fz={22} lh={1}>
              Sezzlee
            </Text>
            <Badge
              variant="outline"
              color="gray"
              radius="xl"
              size="sm"
              ff="monospace"
              fw={500}
            >
              Docs
            </Badge>
          </Anchor>
        </Group>
        <Box className="flex min-w-0 flex-1 justify-center">
          <SearchButton />
        </Box>
        <Group gap={4} wrap="nowrap">
          <Anchor
            href={SITE_LINKS.repository}
            c="dimmed"
            size="sm"
            underline="never"
            visibleFrom="xs"
            className="inline-flex items-center gap-1 px-3 py-2.5"
          >
            GitHub
            <IconArrowUpRight size={14} aria-hidden />
          </Anchor>
          <Anchor
            href={SITE_LINKS.product}
            c="dimmed"
            size="sm"
            underline="never"
            visibleFrom="sm"
            className="px-3 py-2.5"
          >
            sezzlee.app
          </Anchor>
          <ColorSchemeToggle />
        </Group>
      </Group>
    </Container>
  );
}
