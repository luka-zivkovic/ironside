import { formatJsonText } from "./json-text.js";
import {
  looksLikeMarkdown,
  markdownEligibility,
  type MarkdownIneligibilityReason
} from "./markdown.js";
import { stringifyPayload } from "./payload.js";

export type StringPayloadMode = "rendered" | "pretty" | "source" | "raw";

export interface StringPayloadPresentation {
  defaultMode: "rendered" | "pretty" | "source";
  modes: StringPayloadMode[];
  renderedKind: "markdown" | "json" | null;
  markdownDetected: boolean;
  markdownUnavailableReason: MarkdownIneligibilityReason | null;
  prettyText: string | null;
  sourceText: string;
  rawJsonText: string;
}

const MAX_PAYLOAD_SOURCE_LENGTH = 100_000;
const MAX_PAYLOAD_FORMAT_DEPTH = 64;
const MAX_PAYLOAD_OUTPUT_LENGTH = 300_000;
const MAX_STRING_ENCODING_LAYERS = 2;

/**
 * Builds readable and forensic views of a string-valued trace payload.
 *
 * Stored payloads are already parsed once at the API boundary, so ordinary
 * strings need no decoding: showing them directly restores their real
 * whitespace instead of JSON.stringify's visible quotes and escapes. Some
 * SDKs intentionally send JSON as a string, and historical data can contain
 * an additional complete JSON-string layer. Only complete, bounded JSON
 * string literals are unwrapped; backslash replacement would corrupt source
 * code, regular expressions, and Windows paths.
 */
export function presentStringPayload(value: string): StringPayloadPresentation {
  const sourceText = unwrapJsonStringLiterals(value);
  const prettyText = formatJsonText(sourceText, {
    maxSourceLength: MAX_PAYLOAD_SOURCE_LENGTH,
    maxDepth: MAX_PAYLOAD_FORMAT_DEPTH,
    maxOutputLength: MAX_PAYLOAD_OUTPUT_LENGTH
  });
  const markdown = prettyText === null ? markdownEligibility(sourceText) : null;
  const markdownDetected = markdown?.eligible === true && looksLikeMarkdown(sourceText);

  if (prettyText !== null) {
    return {
      defaultMode: "pretty",
      modes: ["pretty", "source", "raw"],
      renderedKind: "json",
      markdownDetected: false,
      markdownUnavailableReason: null,
      prettyText,
      sourceText,
      rawJsonText: stringifyPayload(value)
    };
  }

  if (markdown?.eligible) {
    return {
      defaultMode: markdownDetected ? "rendered" : "source",
      modes: ["rendered", "source", "raw"],
      renderedKind: "markdown",
      markdownDetected,
      markdownUnavailableReason: null,
      prettyText: null,
      sourceText,
      rawJsonText: stringifyPayload(value)
    };
  }

  return {
    defaultMode: "source",
    modes: ["source", "raw"],
    renderedKind: null,
    markdownDetected: false,
    markdownUnavailableReason: markdown?.reason ?? null,
    prettyText: null,
    sourceText,
    rawJsonText: stringifyPayload(value)
  };
}

function unwrapJsonStringLiterals(value: string): string {
  let current = value;

  for (let layer = 0; layer < MAX_STRING_ENCODING_LAYERS; layer += 1) {
    const candidate = current.trim();
    if (
      candidate.length < 2 ||
      candidate.length > MAX_PAYLOAD_SOURCE_LENGTH ||
      candidate[0] !== '"' ||
      candidate[candidate.length - 1] !== '"'
    ) break;

    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed !== "string") break;
      current = parsed;
    } catch {
      break;
    }
  }

  return current;
}
