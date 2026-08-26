# Markdown Payload Rendering v1

Trace and observation input/output are untrusted stored content. Ironside may
render bounded string payloads as Markdown for readability, but rendering must
not create an execution or background-network surface.

## Views

- A bounded non-JSON string offers **Rendered**, **Source**, and **Raw JSON**.
- High-confidence Markdown defaults to Rendered. Ambiguous prose/source defaults
  to Source, while Rendered remains available manually.
- JSON stored inside a string keeps **Pretty**, **Source**, and **Raw JSON**.
- Known message/choice payloads keep their interpreted view and Raw JSON. Only
  recognized human-text fields are eligible for automatic Markdown rendering;
  tool arguments and arbitrary object fields are not recursively interpreted.
- Missing or invalid preference state uses the content-specific automatic
  default. A selected view is stored locally under the authenticated owner's
  `principalId`; it is not synchronized between browsers.

Source is the decoded, whitespace-preserving value introduced by the trace
viewer usability work. Raw JSON is the serialization of the original API value
before display-only decoding. Neither view mutates stored data.

## Detection and bounds

Automatic detection is a deterministic line-oriented heuristic. Paired fences,
tables, task lists, repeated list/quote structure, or combinations of headings
and inline Markdown are positive signals. Incidental punctuation, URLs, logs,
shell comments, diffs, paths, and regexes are not sufficient on their own.

Markdown rendering is unavailable above any of these limits:

- 100,000 decoded source characters;
- 2,000 lines;
- 5,000 Markdown-significant structural tokens;
- estimated nesting depth 64.

The character, line-ending, and structural-token checks run before Markdown is
parsed. An iterative transform also replaces Markdown trees over 5,000 AST
nodes or depth 64 before React elements are created. Source and Raw JSON remain
available without parsing. Syntax highlighting is deliberately omitted.

## Untrusted-content policy

The renderer uses CommonMark plus GFM, followed by an explicit sanitizer
allowlist. It never enables raw HTML, MDX, `dangerouslySetInnerHTML`, Mermaid,
math execution, or embedded media.

- Raw HTML is omitted from Rendered and remains inspectable in Source/Raw JSON.
- Markdown images become inert text placeholders. No attacker-controlled image,
  thumbnail, favicon, preview, or metadata request is emitted.
- Only explicit absolute `http:` and `https:` links are clickable. Relative,
  protocol-relative, malformed, and active-scheme URLs are inert text.
- Allowed links open in a new tab with
  `rel="noopener noreferrer nofollow ugc"`.
- Fenced code is inert monospace text with horizontal scrolling. Long inline
  code wraps inside the inspector.
- GFM task-list controls are forced disabled and removed from keyboard focus.
- No heading-slug plugin is installed, so trace content cannot select DOM IDs.

## Non-goals

No raw HTML, MDX, syntax highlighting, diagrams, math, remote images, media
embeds, relative app links, recursive arbitrary-JSON rendering, editing, API or
database changes, or server-synchronized preferences are part of v1.
