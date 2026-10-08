import {
  Children,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ActionIcon,
  CopyButton,
  Tabs,
  Tooltip,
  Typography,
} from "@mantine/core";
import { IconCheck, IconChevronRight, IconCopy } from "@tabler/icons-react";
import Markdown, { type Components } from "react-markdown";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import { highlight } from "../lib/highlight";
import { remarkDocs } from "../lib/remark-docs";
import classes from "../styles/markdown.module.css";

interface BlockProps {
  "data-block"?: string;
  "data-role"?: string;
  "data-lang"?: string;
  "data-title"?: string;
  "data-label"?: string;
  children?: ReactNode;
}

function blockProps(props: ComponentPropsWithoutRef<"div">): BlockProps {
  const record: Record<string, unknown> = props;
  const read = (key: keyof BlockProps) => {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  };
  return {
    "data-block": read("data-block"),
    "data-role": read("data-role"),
    "data-lang": read("data-lang"),
    "data-title": read("data-title"),
    "data-label": read("data-label"),
    children: props.children,
  };
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textContent(child.props.children)
        : typeof child === "string"
          ? child
          : "",
    )
    .join("");
}

function CopyCode({ code }: Readonly<{ code: string }>) {
  return (
    <CopyButton value={code} timeout={1600}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "Copied" : "Copy"} withArrow position="left">
          <ActionIcon
            variant="subtle"
            color="gray"
            size={32}
            onClick={copy}
            aria-label={copied ? "Copied" : "Copy code"}
            className={classes.copy}
          >
            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}

function CodeBlock({
  block,
  showLabel,
}: Readonly<{ block: BlockProps; showLabel: boolean }>) {
  const code = textContent(block.children).replace(/\n$/, "");
  const isOutput = block["data-role"] === "output";
  const label = isOutput
    ? "Output"
    : (block["data-title"] ?? block["data-lang"] ?? "text");

  return (
    <div className={isOutput ? classes.output : classes.code}>
      {showLabel || isOutput ? (
        <div className={classes.codeHeader}>
          <span className={classes.codeLabel}>{label}</span>
          {isOutput ? null : <CopyCode code={code} />}
        </div>
      ) : (
        <div className={classes.codeFloating}>
          <CopyCode code={code} />
        </div>
      )}
      <pre className={classes.pre}>
        <code>
          {isOutput ? (
            code
          ) : (
            <Highlighted code={code} lang={block["data-lang"] ?? "text"} />
          )}
        </code>
      </pre>
    </div>
  );
}

function Highlighted({ code, lang }: Readonly<{ code: string; lang: string }>) {
  const lines = highlight(code, lang);
  if (lines === null) return code;
  return lines.map((tokens, line) => (
    <span key={line}>
      {line > 0 ? "\n" : null}
      {tokens.map((token, index) => (
        <span
          key={index}
          style={{
            color: token.color,
            fontStyle: token.fontStyle === 1 ? "italic" : undefined,
          }}
        >
          {token.content}
        </span>
      ))}
    </span>
  ));
}

function isBlockElement(node: ReactNode): node is ReactElement<BlockProps> {
  return isValidElement<BlockProps>(node);
}

function CodeTabs({ children }: Readonly<{ children: ReactNode }>) {
  const panels = Children.toArray(children)
    .filter(isBlockElement)
    .map((element, index) => ({
      value: String(index),
      label:
        element.props["data-title"] ?? element.props["data-lang"] ?? "Code",
      element,
    }));
  const first = panels[0];
  if (first === undefined) return null;

  return (
    <Tabs defaultValue={first.value} className={classes.tabs} keepMounted>
      <Tabs.List>
        {panels.map((panel) => (
          <Tabs.Tab key={panel.value} value={panel.value}>
            {panel.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {panels.map((panel) => (
        <Tabs.Panel key={panel.value} value={panel.value}>
          <CodeBlock block={panel.element.props} showLabel={false} />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

function Details({
  label,
  children,
}: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <details className={classes.details}>
      <summary className={classes.detailsSummary}>
        <IconChevronRight
          size={16}
          className={classes.detailsChevron}
          aria-hidden
        />
        {label}
      </summary>
      <div className={classes.detailsBody}>{children}</div>
    </details>
  );
}

function Block(props: ComponentPropsWithoutRef<"div">) {
  const block = blockProps(props);
  switch (block["data-block"]) {
    case "code":
      return <CodeBlock block={block} showLabel />;
    case "tabs":
      return <CodeTabs>{block.children}</CodeTabs>;
    case "details":
      return (
        <Details label={block["data-label"] ?? "Details"}>
          {block.children}
        </Details>
      );
    default:
      return <div {...props} />;
  }
}

const components: Components = {
  div: ({ node: _node, ...props }) => <Block {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className={classes.tableScroll}>
      <table {...props} />
    </div>
  ),
};

/**
 * Renders one docs page body with the site's markdown conventions.
 *
 * @param file The page's content path, named in an unknown-directive error.
 * @param body The page's markdown source.
 */
export function DocMarkdown({
  file,
  body,
}: Readonly<{ file: string; body: string }>) {
  return (
    <Typography className={classes.prose}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkDirective, remarkDocs(file)]}
        components={components}
      >
        {body}
      </Markdown>
    </Typography>
  );
}
