import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { Box, Group } from "@mantine/core";
import { DocMarkdown } from "../components/DocMarkdown";
import { DocsNotFound } from "../components/DocsNotFound";
import { OnThisPage } from "../components/OnThisPage";
import { getDoc, getProduct, getRedirect } from "../lib/content";

export const Route = createFileRoute("/docs/$product/$slug")({
  loader: ({ params }) => {
    const moved = getRedirect(params.product, params.slug);
    if (moved !== undefined) {
      throw redirect({
        to: "/docs/$product/$slug",
        params: { product: params.product, slug: moved },
        statusCode: 301,
      });
    }
    const product = getProduct(params.product);
    const doc = getDoc(params.product, params.slug);
    if (!product || !doc) {
      throw notFound();
    }
    return {
      file: `${doc.product}/${doc.slug}`,
      title: doc.title,
      summary: doc.summary,
      headings: doc.headings,
      body: doc.body,
      productLabel: product.label,
    };
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          {
            title: `${loaderData.title} — ${loaderData.productLabel} — Sezzlee Docs`,
          },
          { name: "description", content: loaderData.summary },
        ]
      : [],
  }),
  component: DocPage,
  notFoundComponent: DocsNotFound,
});

function DocPage() {
  const { file, body, headings } = Route.useLoaderData();

  return (
    <Group align="flex-start" justify="center" gap={56} wrap="nowrap" pb={96}>
      <Box maw={760} className="min-w-0 flex-1">
        <DocMarkdown file={file} body={body} />
      </Box>
      {headings.length >= 2 ? <OnThisPage headings={headings} /> : null}
    </Group>
  );
}
