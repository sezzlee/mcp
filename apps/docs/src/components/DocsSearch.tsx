import { useNavigate } from "@tanstack/react-router";
import { Kbd, UnstyledButton, Text, Group } from "@mantine/core";
import {
  Spotlight,
  spotlight,
  type SpotlightActionGroupData,
} from "@mantine/spotlight";
import { IconSearch } from "@tabler/icons-react";
import { products } from "../lib/content";

export function DocsSpotlight() {
  const navigate = useNavigate();

  const actions: SpotlightActionGroupData[] = products.map((product) => ({
    group: product.label,
    actions: product.docs.map((doc) => ({
      id: `${doc.product}/${doc.slug}`,
      label: doc.title,
      description: doc.summary,
      keywords: [
        product.label,
        product.goal,
        ...doc.headings.map((heading) => heading.text),
      ],
      onClick: () => {
        void navigate({
          to: "/docs/$product/$slug",
          params: { product: doc.product, slug: doc.slug },
        });
      },
    })),
  }));

  return (
    <Spotlight
      actions={actions}
      limit={12}
      scrollable
      maxHeight={480}
      highlightQuery
      nothingFound="No page matches that."
      searchProps={{
        leftSection: <IconSearch size={18} aria-hidden />,
        placeholder: "Search docs",
        "aria-label": "Search docs",
      }}
    />
  );
}

export function SearchButton() {
  return (
    <UnstyledButton
      onClick={spotlight.open}
      aria-label="Search docs"
      className="flex h-10 w-full max-w-[440px] items-center rounded-(--mantine-radius-md) border border-(--mantine-color-default-border) bg-(--mantine-color-body) px-3 hover:bg-(--mantine-color-default-hover)"
    >
      <Group gap="sm" wrap="nowrap" className="w-full">
        <IconSearch size={16} aria-hidden color="var(--mantine-color-dimmed)" />
        <Text fz="sm" c="dimmed" className="flex-1" visibleFrom="xs">
          Search docs
        </Text>
        <Kbd size="xs" visibleFrom="sm">
          ⌘K
        </Kbd>
      </Group>
    </UnstyledButton>
  );
}
