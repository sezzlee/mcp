import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { Box, Group } from "@mantine/core";
import { DocMarkdown } from "../components/DocMarkdown";
import { DocsNotFound } from "../components/DocsNotFound";
import { OnThisPage } from "../components/OnThisPage";
import { getDoc, getProduct, getRedirect } from "../lib/content";
import { ORGANIZATION_ID, SITE_ORIGIN, SITE_TITLE } from "../lib/site";

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
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {};
    }
    const url = `${SITE_ORIGIN}/docs/${loaderData.file}`;
    return {
      meta: [
        {
          title: `${loaderData.title} — ${loaderData.productLabel} — ${SITE_TITLE}`,
        },
        { name: "description", content: loaderData.summary },
        { property: "og:type", content: "article" },
        { property: "og:url", content: url },
        {
          property: "og:title",
          content: `${loaderData.title} — ${loaderData.productLabel}`,
        },
        { property: "og:description", content: loaderData.summary },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "TechArticle",
            headline: loaderData.title,
            description: loaderData.summary,
            url,
            inLanguage: "en",
            about: loaderData.productLabel,
            isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
            publisher: { "@id": ORGANIZATION_ID },
          }),
        },
      ],
    };
  },
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
