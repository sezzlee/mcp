/// <reference types="vite/client" />
import type { ReactNode } from "react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps,
} from "@mantine/core";
import { DocsSpotlight } from "../components/DocsSearch";
import appCss from "../styles/app.css?url";
import { theme } from "../theme";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Sezzlee Docs" },
      {
        name: "description",
        content:
          "Connect spreadsheets, PDFs, XML, SQL Server and your own API to any MCP agent with Sezzlee's open-source servers.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
        <HeadContent />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="auto">
          {children}
          <DocsSpotlight />
        </MantineProvider>
        <Scripts />
      </body>
    </html>
  );
}
