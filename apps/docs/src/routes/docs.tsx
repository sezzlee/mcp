import {
  Link,
  Outlet,
  createFileRoute,
  useMatchRoute,
  useParams,
} from "@tanstack/react-router";
import {
  AppShell,
  Box,
  Burger,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconSelector } from "@tabler/icons-react";
import { ProductIcon } from "../components/ProductIcon";
import { SiteHeader } from "../components/SiteHeader";
import {
  defaultProduct,
  getProduct,
  products,
  type Product,
} from "../lib/content";

export const Route = createFileRoute("/docs")({
  component: DocsLayout,
});

function GroupLabel({ children }: Readonly<{ children: string }>) {
  return (
    <Text
      ff="monospace"
      fz={11}
      c="dimmed"
      tt="uppercase"
      px="sm"
      pb={6}
      className="tracking-[0.08em]"
    >
      {children}
    </Text>
  );
}

function ProductSwitcher({
  active,
  onPick,
}: Readonly<{ active: Product; onPick: () => void }>) {
  return (
    <Menu position="bottom-start" width="target" withinPortal={false}>
      <Menu.Target>
        <UnstyledButton
          aria-label={`Product: ${active.label}. Switch product`}
          className="w-full rounded-(--mantine-radius-md) border border-(--mantine-color-default-border) px-3 py-2.5 hover:bg-(--mantine-color-default-hover)"
        >
          <Group gap="sm" wrap="nowrap">
            <Box c="var(--mantine-primary-color-filled)" className="flex">
              <ProductIcon product={active.id} size={20} />
            </Box>
            <Text fw={600} fz="sm" className="flex-1">
              {active.label}
            </Text>
            <IconSelector size={16} aria-hidden />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {products.map((product) => (
          <Menu.Item
            key={product.id}
            leftSection={<ProductIcon product={product.id} size={16} />}
            onClick={onPick}
            renderRoot={(props) => (
              <Link
                to="/docs/$product/$slug"
                params={{ product: product.id, slug: product.firstSlug }}
                {...props}
              />
            )}
          >
            {product.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function DocsLayout() {
  const [opened, { toggle, close }] = useDisclosure(false);
  const matchRoute = useMatchRoute();
  const params = useParams({ strict: false });
  const active = getProduct(params.product ?? "") ?? defaultProduct;

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: 288, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="xl"
    >
      <AppShell.Header>
        <SiteHeader
          width="full"
          leading={
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
          }
        />
      </AppShell.Header>

      <AppShell.Navbar p="md">
        {active ? (
          <>
            <ProductSwitcher active={active} onPick={close} />
            <ScrollArea type="scroll" mt="md" className="flex-1">
              {active.groups.map((group) => (
                <Box key={group.key ?? "root"} mb="md">
                  {group.label === "" ? null : (
                    <GroupLabel>{group.label}</GroupLabel>
                  )}
                  {group.docs.map((doc) => (
                    <NavLink
                      key={doc.slug}
                      label={doc.navLabel}
                      active={
                        !!matchRoute({
                          to: "/docs/$product/$slug",
                          params: { product: doc.product, slug: doc.slug },
                        })
                      }
                      onClick={close}
                      renderRoot={(props) => (
                        <Link
                          to="/docs/$product/$slug"
                          params={{ product: doc.product, slug: doc.slug }}
                          {...props}
                        />
                      )}
                    />
                  ))}
                </Box>
              ))}
            </ScrollArea>
          </>
        ) : null}
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
