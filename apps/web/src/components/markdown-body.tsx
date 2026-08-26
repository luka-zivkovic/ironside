import Markdown, { type Components, type Options, type UrlTransform } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  limitMarkdownAst,
  markdownEligibility,
  safeMarkdownHref
} from "@/lib/markdown";
import { cn } from "@/lib/utils";

const TRACE_MARKDOWN_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul"
];

const TRACE_MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: TRACE_MARKDOWN_TAGS,
  attributes: {
    a: ["href"],
    code: [["className", /^language-[A-Za-z0-9_-]+$/]],
    img: ["alt"],
    input: [["type", "checkbox"], "checked", "disabled"],
    ol: ["start"],
    td: ["align"],
    th: ["align"]
  },
  protocols: {
    href: ["http", "https"]
  },
  clobberPrefix: "ironside-trace-"
};

const markdownComponents: Components = {
  p({ children }) {
    return <p className="payload-markdown-paragraph">{children}</p>;
  },
  h1({ children }) {
    return <h1 className="payload-markdown-h1">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="payload-markdown-h2">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="payload-markdown-h3">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="payload-markdown-h4">{children}</h4>;
  },
  h5({ children }) {
    return <h5 className="payload-markdown-h5">{children}</h5>;
  },
  h6({ children }) {
    return <h6 className="payload-markdown-h6">{children}</h6>;
  },
  a({ children, href }) {
    const safeHref = safeMarkdownHref(href);
    if (!safeHref) return <span className="payload-markdown-inert-link">{children}</span>;
    return (
      <a
        className="payload-markdown-link"
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer nofollow ugc"
      >
        {children}
      </a>
    );
  },
  img({ alt }) {
    return (
      <span className="payload-markdown-image-placeholder">
        [Image not loaded{alt ? `: ${alt}` : ""}]
      </span>
    );
  },
  ul({ children }) {
    return <ul className="payload-markdown-list payload-markdown-unordered">{children}</ul>;
  },
  ol({ children, start }) {
    return <ol className="payload-markdown-list payload-markdown-ordered" start={start}>{children}</ol>;
  },
  li({ children }) {
    return <li>{children}</li>;
  },
  blockquote({ children }) {
    return <blockquote className="payload-markdown-quote">{children}</blockquote>;
  },
  pre({ children }) {
    return (
      <pre
        className="payload-markdown-code-block"
        role="region"
        aria-label="Markdown code block"
        tabIndex={0}
      >
        {children}
      </pre>
    );
  },
  code({ children, className }) {
    const languageClass = typeof className === "string" && /^language-[A-Za-z0-9_-]+$/.test(className)
      ? className
      : undefined;
    return <code className={cn("payload-markdown-code", languageClass)}>{children}</code>;
  },
  table({ children }) {
    return (
      <div
        className="payload-markdown-table-scroll"
        role="region"
        aria-label="Markdown table"
        tabIndex={0}
      >
        <table>{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead>{children}</thead>;
  },
  tbody({ children }) {
    return <tbody>{children}</tbody>;
  },
  tr({ children }) {
    return <tr>{children}</tr>;
  },
  th({ children }) {
    return <th>{children}</th>;
  },
  td({ children }) {
    return <td>{children}</td>;
  },
  input({ checked }) {
    return <input type="checkbox" checked={Boolean(checked)} disabled tabIndex={-1} />;
  },
  hr() {
    return <hr className="payload-markdown-rule" />;
  }
};

const markdownUrlTransform: UrlTransform = (url, key) => key === "href" ? safeMarkdownHref(url) ?? "" : "";
const remarkPlugins: NonNullable<Options["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
  limitMarkdownAst
];
const rehypePlugins: NonNullable<Options["rehypePlugins"]> = [
  [rehypeSanitize, TRACE_MARKDOWN_SCHEMA]
];

export function MarkdownBody({ source, className }: { source: string; className?: string }) {
  const eligibility = markdownEligibility(source);
  if (!eligibility.eligible) {
    return (
      <div className={cn("text-[11.5px] italic text-ink-4", className)}>
        This payload is too large or deeply nested to render safely. Use Source instead.
      </div>
    );
  }

  return (
    <div className={cn("payload-markdown text-[12.5px] leading-5 text-ink-2", className)}>
      <Markdown
        skipHtml
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {source}
      </Markdown>
    </div>
  );
}
