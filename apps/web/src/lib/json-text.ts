const MAX_JSON_TEXT_LENGTH = 32_768;
const MAX_JSON_FORMAT_DEPTH = 32;
const MAX_FORMATTED_JSON_LENGTH = 100_000;

export interface JsonTextFormatLimits {
  maxSourceLength?: number;
  maxDepth?: number;
  maxOutputLength?: number;
}

interface ContainerState {
  closing: "]" | "}";
  expanded: boolean;
}

/**
 * Pretty-prints a bounded JSON object or array without parsing and
 * reserializing its values. This preserves exact number and string tokens for
 * the trace viewer while still rejecting malformed input.
 */
export function formatJsonText(value: string, limits: JsonTextFormatLimits = {}): string | null {
  const maxSourceLength = limits.maxSourceLength ?? MAX_JSON_TEXT_LENGTH;
  const maxDepth = limits.maxDepth ?? MAX_JSON_FORMAT_DEPTH;
  const maxOutputLength = limits.maxOutputLength ?? MAX_FORMATTED_JSON_LENGTH;
  const source = value.trim();
  const first = source[0];
  const last = source[source.length - 1];
  if (
    source.length < 2 ||
    source.length > maxSourceLength ||
    !((first === "{" && last === "}") || (first === "[" && last === "]"))
  ) return null;

  const stack: ContainerState[] = [];
  let output = "";
  let inString = false;
  let escaped = false;
  let indentLevel = 0;

  const appendIndent = () => "  ".repeat(indentLevel);

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      if (output.length > maxOutputLength) return null;
      continue;
    }

    if (/\s/.test(character)) continue;
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "{" || character === "[") {
      if (stack.length >= maxDepth) return null;
      const closing = character === "{" ? "}" : "]";
      let nextIndex = index + 1;
      while (nextIndex < source.length && /\s/.test(source[nextIndex]!)) nextIndex += 1;
      const expanded = source[nextIndex] !== closing;
      stack.push({ closing, expanded });
      output += character;
      if (expanded) {
        indentLevel += 1;
        output += `\n${appendIndent()}`;
      }
    } else if (character === "}" || character === "]") {
      const container = stack.pop();
      if (!container || container.closing !== character) return null;
      if (container.expanded) {
        indentLevel -= 1;
        output += `\n${appendIndent()}${character}`;
      } else {
        output += character;
      }
    } else if (character === ",") {
      output += `,\n${appendIndent()}`;
    } else if (character === ":") {
      output += ": ";
    } else {
      output += character;
    }

    if (output.length > maxOutputLength) return null;
  }

  if (inString || stack.length > 0 || indentLevel !== 0) return null;
  try {
    JSON.parse(source);
  } catch {
    return null;
  }
  return output;
}
