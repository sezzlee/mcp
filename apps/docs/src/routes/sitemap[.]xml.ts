import { createFileRoute } from "@tanstack/react-router";
import { products } from "../lib/content";
import { SITE_ORIGIN } from "../lib/site";

const urls = [
  `${SITE_ORIGIN}/`,
  ...products.flatMap((product) =>
    product.docs.map((doc) => `${SITE_ORIGIN}/docs/${product.id}/${doc.slug}`),
  ),
];

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls.map((url) => `  <url><loc>${url}</loc></url>`),
  "</urlset>",
  "",
].join("\n");

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(sitemap, {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        }),
    },
  },
});
