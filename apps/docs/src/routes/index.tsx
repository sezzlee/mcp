import { Link, createFileRoute } from "@tanstack/react-router";
import { Anchor, Box, Container, SimpleGrid, Text, Title } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { ProductIcon } from "../components/ProductIcon";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { products } from "../lib/content";
import classes from "../styles/home.module.css";

export const Route = createFileRoute("/")({
  component: Home,
});

const TASKS_PER_PRODUCT = 3;

const taskGroups = products
  .map((product) => {
    const all = product.docs.filter((doc) => doc.section === "recipes");
    return {
      product,
      shown: all.slice(0, TASKS_PER_PRODUCT),
      total: all.length,
    };
  })
  .filter((group) => group.total > 0);

function Home() {
  return (
    <>
      <Box
        component="header"
        h={64}
        pos="sticky"
        top={0}
        className="z-10 border-b border-(--mantine-color-default-border) bg-(--mantine-color-body)"
      >
        <SiteHeader leading={null} width="contained" />
      </Box>

      <Container component="main" size={1280} px="lg">
        <Box component="section" pt={96} pb={56} maw={760}>
          <Text
            ff="monospace"
            fz="xs"
            c="dimmed"
            tt="uppercase"
            className="tracking-[0.08em]"
          >
            Open-source MCP servers · MIT
          </Text>
          <Title
            order={1}
            mt="md"
            fz="clamp(2.5rem, 5vw, 4.25rem)"
            lh={1.02}
            className="tracking-[-0.02em]"
          >
            What should your agent read?
          </Title>
          <Text mt="lg" fz="lg" c="dimmed" maw="56ch" lh={1.55}>
            Pick a source. Follow one page. Ask your first question in a few
            minutes.
          </Text>
        </Box>

        <Box component="section" aria-label="Sources" pb={96}>
          <div className={classes.goals}>
            {products.map((product) => (
              <Link
                key={product.id}
                to="/docs/$product/$slug"
                params={{ product: product.id, slug: product.firstSlug }}
                className={classes.goal}
              >
                <span className={classes.goalIcon}>
                  <ProductIcon product={product.id} size={28} />
                </span>
                <Text component="span" ff="heading" fz={26} lh={1.15} mt="xs">
                  {product.goal}
                </Text>
                <Text component="span" fz="sm" c="dimmed" lh={1.5}>
                  {product.tagline}
                </Text>
                <span className={classes.goalLink}>{product.label} →</span>
              </Link>
            ))}
          </div>
        </Box>

        {taskGroups.length > 0 ? (
          <Box component="section" aria-labelledby="tasks" pb={112}>
            <Title id="tasks" order={2} fz={32} lh={1.1}>
              Common tasks
            </Title>
            <Text mt="sm" fz="sm" c="dimmed" maw="48ch" lh={1.55}>
              Each one fits on a screen: the goal, the call, the result.
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={40} mt={40}>
              {taskGroups.map(({ product, shown, total }) => (
                <Box key={product.id}>
                  <Text
                    ff="monospace"
                    fz="xs"
                    c="dimmed"
                    tt="uppercase"
                    pb="xs"
                    className="tracking-[0.08em]"
                  >
                    {product.label}
                  </Text>
                  <ul className="m-0 list-none border-t border-(--mantine-color-default-border) p-0">
                    {shown.map((recipe) => (
                      <li key={recipe.slug}>
                        <Link
                          to="/docs/$product/$slug"
                          params={{
                            product: recipe.product,
                            slug: recipe.slug,
                          }}
                          className={classes.task}
                        >
                          <Text component="span" fz="sm" className="flex-1">
                            {recipe.title}
                          </Text>
                          <IconArrowRight
                            size={16}
                            aria-hidden
                            color="var(--mantine-primary-color-filled)"
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {total > shown.length ? (
                    <Anchor
                      fz="sm"
                      mt="sm"
                      display="inline-block"
                      renderRoot={(props) => (
                        <Link
                          to="/docs/$product/$slug"
                          params={{
                            product: product.id,
                            slug: product.firstSlug,
                          }}
                          {...props}
                        />
                      )}
                    >
                      All {total} {product.label} recipes →
                    </Anchor>
                  ) : null}
                </Box>
              ))}
            </SimpleGrid>
          </Box>
        ) : null}
      </Container>

      <SiteFooter />
    </>
  );
}
