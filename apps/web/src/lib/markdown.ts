export const MAX_MARKDOWN_SOURCE_LENGTH = 100_000;
export const MAX_MARKDOWN_LINES = 2_000;
export const MAX_MARKDOWN_NESTING_DEPTH = 64;
export const MAX_MARKDOWN_AST_NODES = 5_000;
export const MAX_MARKDOWN_STRUCTURE_TOKENS = 5_000;

export type MarkdownIneligibilityReason = "empty" | "length" | "lines" | "depth" | "complexity";

export type MarkdownEligibility =
  | { eligible: true; reason: null }
  | { eligible: false; reason: MarkdownIneligibilityReason };

interface MarkdownAstNode {
  type: string;
  children?: MarkdownAstNode[];
  value?: string;
}

interface MarkdownAstRoot extends MarkdownAstNode {
  type: "root";
  children: MarkdownAstNode[];
}

const COMPLEXITY_NOTICE = "Rendering unavailable: Markdown structure is too complex. Use Source instead.";

/**
 * Rejects payloads that could create an excessive Markdown DOM or overflow a
 * recursive parser/tree walk. The scan is linear and non-recursive so hostile
 * input cannot make the guard itself overflow.
 */
export function markdownEligibility(source: string): MarkdownEligibility {
  if (source.length === 0) return { eligible: false, reason: "empty" };
  if (source.length > MAX_MARKDOWN_SOURCE_LENGTH) return { eligible: false, reason: "length" };

  let lines = 1;
  let structureTokens = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      lines += 1;
      if (lines > MAX_MARKDOWN_LINES) return { eligible: false, reason: "lines" };
      continue;
    }

    if (isMarkdownStructureToken(character)) {
      structureTokens += 1;
      if (structureTokens > MAX_MARKDOWN_STRUCTURE_TOKENS) {
        return { eligible: false, reason: "complexity" };
      }
    }
  }

  if (estimateMarkdownNestingDepth(source) > MAX_MARKDOWN_NESTING_DEPTH) {
    return { eligible: false, reason: "depth" };
  }

  return { eligible: true, reason: null };
}

/**
 * Conservative automatic detection. Ambiguous strings remain Source by
 * default, while every eligible non-JSON string still offers Rendered as an
 * explicit escape hatch for false negatives.
 */
export function looksLikeMarkdown(source: string): boolean {
  if (!markdownEligibility(source).eligible) return false;

  const lines = source.split(/\r?\n/);
  let headings = 0;
  let higherLevelHeadings = 0;
  let listItems = 0;
  let blockquotes = 0;
  let taskItems = 0;
  let fenceCharacter: "`" | "~" | null = null;
  let matchedFence = false;

  const looksLikeDiff = lines.some((line) =>
    /^diff --git\s/.test(line) || /^@@\s.+\s@@/.test(line) || /^---\s+[ab]\//.test(line)
  );

  for (const line of lines) {
    const heading = /^ {0,3}(#{1,6})[\t ]+\S/.exec(line);
    if (heading) {
      headings += 1;
      if ((heading[1]?.length ?? 1) > 1) higherLevelHeadings += 1;
    }
    if (/^ {0,3}(?:[-+*]|\d+[.)])[\t ]+\S/.test(line)) listItems += 1;
    if (/^ {0,3}>[\t ]*\S/.test(line)) blockquotes += 1;
    if (/^ {0,3}[-+*][\t ]+\[[ xX]\][\t ]+\S/.test(line)) taskItems += 1;

    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) continue;
    const currentCharacter = fence.startsWith("`") ? "`" : "~";
    if (fenceCharacter === null) fenceCharacter = currentCharacter;
    else if (fenceCharacter === currentCharacter) matchedFence = true;
  }

  if (matchedFence || taskItems > 0 || (headings >= 2 && higherLevelHeadings > 0) || blockquotes >= 2) return true;
  if (!looksLikeDiff && listItems >= 2) return true;
  if (hasGfmTable(lines)) return true;

  let weakSignals = 0;
  if (/\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)/.test(source)) weakSignals += 1;
  // Double underscores are common code identifiers (for example __DEV__) and
  // are too ambiguous for automatic rendering. They remain available through
  // the manual Rendered view.
  if (/\*\*[^*\n]+\*\*/.test(source)) weakSignals += 1;
  if (/~~[^\n~]+~~/.test(source)) weakSignals += 1;
  if (/(^|[^`])`[^`\n]+`([^`]|$)/.test(source)) weakSignals += 1;
  if (hasSetextHeading(lines)) weakSignals += 1;

  if (headings > 0 && (listItems > 0 || blockquotes > 0 || weakSignals > 0)) return true;
  return weakSignals >= 2;
}

/** Absolute web links only; trace-relative navigation and active schemes are inert. */
export function safeMarkdownHref(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate)) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname.length === 0) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Final iterative AST budget. This plugin runs before the Markdown tree is
 * converted to React elements and replaces an excessive tree with a notice.
 */
export function limitMarkdownAst() {
  return (candidate: unknown): void => {
    const tree = candidate as MarkdownAstRoot;
    let nodeCount = 0;
    const stack: Array<{ node: MarkdownAstNode; depth: number }> = [{ node: tree, depth: 0 }];

    while (stack.length > 0) {
      const entry = stack.pop();
      if (!entry) break;
      nodeCount += 1;
      if (nodeCount > MAX_MARKDOWN_AST_NODES || entry.depth > MAX_MARKDOWN_NESTING_DEPTH) {
        tree.children = [{
          type: "paragraph",
          children: [{ type: "text", value: COMPLEXITY_NOTICE }]
        }];
        return;
      }
      for (const child of entry.node.children ?? []) {
        stack.push({ node: child, depth: entry.depth + 1 });
      }
    }
  };
}

export function markdownComplexityNotice(): string {
  return COMPLEXITY_NOTICE;
}

function hasGfmTable(lines: string[]): boolean {
  for (let index = 1; index < lines.length; index += 1) {
    const separator = lines[index]?.trim() ?? "";
    const header = lines[index - 1] ?? "";
    if (
      header.includes("|") &&
      /^\|?[\t ]*:?-{3,}:?[\t ]*(?:\|[\t ]*:?-{3,}:?[\t ]*)+\|?$/.test(separator)
    ) return true;
  }
  return false;
}

function hasSetextHeading(lines: string[]): boolean {
  for (let index = 1; index < lines.length; index += 1) {
    if (
      /^ {0,3}(?:=+|-+)[\t ]*$/.test(lines[index] ?? "") &&
      (lines[index - 1] ?? "").trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

function estimateMarkdownNestingDepth(source: string): number {
  let maximum = 0;
  let lineStart = 0;
  let delimiter = "";
  let delimiterRun = 0;

  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index] ?? "\n";
    if (character === "\n" || character === "\r") {
      maximum = Math.max(maximum, estimateLinePrefixDepth(source.slice(lineStart, index)));
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      lineStart = index + 1;
      delimiter = "";
      delimiterRun = 0;
      continue;
    }

    if (character === "*" || character === "_" || character === "~") {
      if (delimiter === character) delimiterRun += 1;
      else {
        delimiter = character;
        delimiterRun = 1;
      }
      maximum = Math.max(maximum, delimiterRun);
    } else {
      delimiter = "";
      delimiterRun = 0;
    }
  }

  return maximum;
}

function isMarkdownStructureToken(character: string): boolean {
  return "!#&()*+<>[\\]_`|~-".includes(character);
}

function estimateLinePrefixDepth(line: string): number {
  let index = 0;
  let indentation = 0;
  let containers = 0;

  while (index < line.length && (line[index] === " " || line[index] === "\t")) {
    indentation += line[index] === "\t" ? 2 : 1;
    index += 1;
  }

  while (index < line.length) {
    if (line[index] === ">") {
      containers += 1;
      index += 1;
      while (line[index] === " " || line[index] === "\t") index += 1;
      continue;
    }
    if (/[-+*]/.test(line[index] ?? "") && /[\t ]/.test(line[index + 1] ?? "")) {
      containers += 1;
    }
    break;
  }

  return containers + Math.floor(indentation / 2);
}
