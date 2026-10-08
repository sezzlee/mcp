import { Anchor, Container, Group, Text } from "@mantine/core";
import { SITE_LINKS } from "../lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-(--mantine-color-default-border)">
      <Container size={1280} px="lg" py="xl">
        <Group gap="lg" c="dimmed" fz="sm">
          <Text ff="heading" fz={18} c="var(--mantine-color-text)">
            Sezzlee
          </Text>
          <Text fz="sm">MIT licensed</Text>
          <Anchor href={SITE_LINKS.repository} c="dimmed" fz="sm">
            GitHub
          </Anchor>
          <Anchor href={SITE_LINKS.specification} c="dimmed" fz="sm">
            Specification
          </Anchor>
          <Anchor href={SITE_LINKS.roadmap} c="dimmed" fz="sm">
            Roadmap
          </Anchor>
        </Group>
      </Container>
    </footer>
  );
}
