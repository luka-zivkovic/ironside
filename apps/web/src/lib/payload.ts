export interface PayloadToolCall {
  id: string | null;
  name: string;
  arguments: unknown;
}

export interface PayloadMessage {
  role: string;
  name: string | null;
  content: unknown;
  contentFormat: "legacy" | "otel";
  toolCallId: string | null;
  toolCalls: PayloadToolCall[];
  unrecognizedToolCalls: unknown[];
}

export interface PayloadChoice {
  index: number | string | null;
  finishReason: string | null;
  message: PayloadMessage;
}

export type PayloadInterpretation =
  | {
      kind: "messages";
      messages: PayloadMessage[];
    }
  | {
      kind: "choices";
      choices: PayloadChoice[];
    }
  | { kind: "json" };

const KNOWN_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
const MAX_FORMATTED_MESSAGES = 200;
const MAX_FORMATTED_CONTENT_PARTS = 200;
const MAX_FORMATTED_TOOL_CALLS = 200;

export function interpretPayload(value: unknown): PayloadInterpretation {
  const standardChoices = readStandardChoices(value);
  if (standardChoices) {
    return {
      kind: "choices",
      choices: standardChoices
    };
  }
  if (hasStandardChoiceMarker(value)) return { kind: "json" };

  const directMessages = readMessageArray(value);
  if (directMessages) {
    return {
      kind: "messages",
      messages: directMessages.map(normalizeMessage)
    };
  }

  if (isRecord(value)) {
    const wrappedMessages = readMessageArray(value.messages);
    if (wrappedMessages) {
      return {
        kind: "messages",
        messages: wrappedMessages.map(normalizeMessage)
      };
    }

    const choices = readChoices(value.choices);
    if (choices) {
      return {
        kind: "choices",
        choices
      };
    }

    if (isMessage(value)) {
      return {
        kind: "messages",
        messages: [normalizeMessage(value)]
      };
    }
  }

  return { kind: "json" };
}

export function stringifyPayload(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
}

function readMessageArray(value: unknown): Record<string, unknown>[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_FORMATTED_MESSAGES ||
    !value.every(isMessage) ||
    countToolCalls(value) > MAX_FORMATTED_TOOL_CALLS ||
    countContentParts(value) > MAX_FORMATTED_CONTENT_PARTS
  ) return null;
  return value;
}

function readChoices(value: unknown): PayloadChoice[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FORMATTED_MESSAGES) return null;
  const choices: PayloadChoice[] = [];
  let toolCallCount = 0;
  let contentPartCount = 0;
  for (const choice of value) {
    if (!isRecord(choice) || !isMessage(choice.message)) return null;
    toolCallCount += Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls.length : 0;
    contentPartCount += Array.isArray(choice.message.content)
      ? choice.message.content.length
      : Array.isArray(choice.message.parts)
        ? choice.message.parts.length
        : 0;
    if (toolCallCount > MAX_FORMATTED_TOOL_CALLS || contentPartCount > MAX_FORMATTED_CONTENT_PARTS) return null;
    choices.push({
      index: typeof choice.index === "number" || typeof choice.index === "string" ? choice.index : null,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      message: normalizeMessage(choice.message)
    });
  }
  return choices;
}

function readStandardChoices(value: unknown): PayloadChoice[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FORMATTED_MESSAGES) return null;
  if (!value.every(isStandardOutputMessage)) return null;
  if (
    countContentParts(value) > MAX_FORMATTED_CONTENT_PARTS ||
    countToolCalls(value) > MAX_FORMATTED_TOOL_CALLS
  ) return null;

  return value.map((message, index) => ({
    index,
    finishReason: message.finish_reason as string,
    message: normalizeMessage(message)
  }));
}

function hasStandardChoiceMarker(value: unknown): boolean {
  return Array.isArray(value) && value.some(
    (message) => isRecord(message) && Array.isArray(message.parts) && "finish_reason" in message
  );
}

function countToolCalls(messages: Record<string, unknown>[]): number {
  return messages.reduce(
    (count, message) => count + (Array.isArray(message.tool_calls) ? message.tool_calls.length : 0),
    0
  );
}

function countContentParts(messages: Record<string, unknown>[]): number {
  return messages.reduce(
    (count, message) => count +
      (Array.isArray(message.content)
        ? message.content.length
        : Array.isArray(message.parts)
          ? message.parts.length
          : 0),
    0
  );
}

function isMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.role !== "string" || value.role.length === 0) return false;
  if (Array.isArray(value.content) && value.content.length > MAX_FORMATTED_CONTENT_PARTS) return false;
  if (Array.isArray(value.tool_calls) && value.tool_calls.length > MAX_FORMATTED_TOOL_CALLS) return false;
  const hasContent = "content" in value && value.content !== null && value.content !== undefined;
  const hasToolCalls = Array.isArray(value.tool_calls) && value.tool_calls.length > 0;
  const hasPartsField = "parts" in value;
  const hasStandardParts = isStandardParts(value.parts);
  if (hasPartsField && !hasStandardParts) return false;
  if (hasContent && hasPartsField) return false;
  if (hasStandardParts) return true;
  if (!KNOWN_ROLES.has(value.role)) return false;
  return hasContent || hasToolCalls;
}

function isStandardOutputMessage(value: unknown): value is Record<string, unknown> {
  return isMessage(value) && isStandardParts(value.parts) && typeof value.finish_reason === "string";
}

function isStandardParts(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) &&
    value.length <= MAX_FORMATTED_CONTENT_PARTS &&
    value.every((part) => isRecord(part) && typeof part.type === "string");
}

function normalizeMessage(message: Record<string, unknown>): PayloadMessage {
  const hasStandardParts = isStandardParts(message.parts);
  const toolCalls: PayloadToolCall[] = [];
  const unrecognizedToolCalls: unknown[] = [];
  for (const rawToolCall of !hasStandardParts && Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const normalized = normalizeToolCall(rawToolCall);
    if (normalized) toolCalls.push(normalized);
    else unrecognizedToolCalls.push(rawToolCall);
  }

  return {
    role: message.role as string,
    name: typeof message.name === "string" ? message.name : null,
    content: hasStandardParts ? message.parts : message.content,
    contentFormat: hasStandardParts ? "otel" : "legacy",
    toolCallId: !hasStandardParts && typeof message.tool_call_id === "string" ? message.tool_call_id : null,
    toolCalls,
    unrecognizedToolCalls
  };
}

function normalizeToolCall(value: unknown): PayloadToolCall | null {
  if (!isRecord(value)) return null;

  const nestedFunction = isRecord(value.function) ? value.function : null;
  const name =
    typeof nestedFunction?.name === "string"
      ? nestedFunction.name
      : typeof value.name === "string"
        ? value.name
        : null;
  if (!name) return null;

  const args = nestedFunction
    ? nestedFunction.arguments
    : "arguments" in value
      ? value.arguments
      : "args" in value
        ? value.args
        : undefined;

  return {
    id: typeof value.id === "string" ? value.id : null,
    name,
    // Keep serialized arguments as their original string. Parsing JSON here
    // can round 64-bit identifiers and make the interpreted view disagree
    // with the stored payload.
    arguments: args
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
