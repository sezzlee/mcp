import { createTheme } from "@mantine/core";

export const theme = createTheme({
  white: "#faf7f2",
  black: "#1d1a15",
  primaryColor: "verdigris",
  primaryShade: { light: 6, dark: 4 },
  colors: {
    verdigris: [
      "#eef6f5",
      "#dcebe9",
      "#b6d3cf",
      "#8fbab4",
      "#6fbfb4",
      "#4b8680",
      "#2c6763",
      "#1f5f5b",
      "#184b48",
      "#103634",
    ],
    gray: [
      "#f6f3ee",
      "#f2eee7",
      "#e9e4dc",
      "#ddd7cd",
      "#c9c2b6",
      "#a39b8f",
      "#6e675c",
      "#524c43",
      "#36312a",
      "#1d1a15",
    ],
    dark: [
      "#ece6dc",
      "#cfc8bc",
      "#9a9287",
      "#6f685e",
      "#3a3732",
      "#2a2825",
      "#1a1917",
      "#121110",
      "#0d0c0b",
      "#080707",
    ],
  },
  fontFamily:
    '"Public Sans Variable", ui-sans-serif, system-ui, -apple-system, sans-serif',
  fontFamilyMonospace:
    '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  headings: {
    fontFamily: '"Newsreader Variable", ui-serif, Georgia, serif',
    fontWeight: "400",
  },
  defaultRadius: "md",
});
