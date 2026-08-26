import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { MarkdownBody } from "@/components/markdown-body";
import {
  interpretPayload,
  stringifyPayload,
  type PayloadChoice,
  type PayloadMessage,
  type PayloadToolCall
} from "@/lib/payload";
import { presentStringPayload, type StringPayloadMode } from "@/lib/payload-display";
import { looksLikeMarkdown } from "@/lib/markdown";
import { usePayloadViewPreference } from "@/lib/payload-view-preference";
import { cn } from "@/lib/utils";

export function PayloadViewer({ value }: { value: unknown }) {
  const rawText = useMemo(() => stringifyPayload(value), [value]);
  const stringPresentation = useMemo(
    () => typeof value === "string" ? presentStringPayload(value) : null,
    [value]
  );
  const interpretation = useMemo(
    () => stringPresentation === null && rawText.length <= 100_000
      ? interpretPayload(value)
      : { kind: "json" as const },
    [rawText, stringPresentation, value]
  );
  const { preference, setPreference } = usePayloadViewPreference();
  const canShowFormatted = interpretation.kind === "messages" || interpretation.kind === "choices";
  const activeMode = stringPresentation !== null
    ? preference !== null && stringPresentation.modes.includes(preference as StringPayloadMode)
      ? preference as StringPayloadMode
      : stringPresentation.defaultMode
    : canShowFormatted
      ? preference === "raw" ? "raw" : "rendered"
      : "raw";
  const formattedLabel = interpretation.kind === "choices" ? "Choices" : "Messages";
  const hasViewSelector = stringPresentation !== null || canShowFormatted;

  return (
    <div className="payload-viewer min-w-0 w-full overflow-hidden rounded-sm border border-rule-soft bg-card-2">
      {hasViewSelector ? (
        <div className="flex items-center justify-between gap-2 border-b border-rule-soft px-2 py-1.5">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-4">
            {stringPresentation !== null
              ? stringPayloadLabel(stringPresentation)
              : interpretation.kind === "choices" ? "Detected completion choices" : "Detected message format"}
          </div>
          <div
            className="flex items-center rounded-sm border border-rule-soft bg-paper-2 p-0.5"
            role="group"
            aria-label="Payload view"
          >
            {stringPresentation?.modes.includes("rendered") ? (
              <ViewButton active={activeMode === "rendered"} onClick={() => setPreference("rendered")}>Rendered</ViewButton>
            ) : null}
            {stringPresentation?.modes.includes("pretty") ? (
              <ViewButton active={activeMode === "pretty"} onClick={() => setPreference("pretty")}>Pretty</ViewButton>
            ) : null}
            {stringPresentation !== null ? (
              <ViewButton active={activeMode === "source"} onClick={() => setPreference("source")}>Source</ViewButton>
            ) : canShowFormatted ? (
              <ViewButton active={activeMode === "rendered"} onClick={() => setPreference("rendered")}>{formattedLabel}</ViewButton>
            ) : null}
            <ViewButton
              active={activeMode === "raw"}
              onClick={() => setPreference("raw")}
              title="JSON value received by the viewer"
            >
              Raw JSON
            </ViewButton>
          </div>
        </div>
      ) : null}

      {stringPresentation?.renderedKind === "markdown" && activeMode === "rendered" ? (
        <div className="payload-scroll p-3">
          <MarkdownBody source={stringPresentation.sourceText} />
        </div>
      ) : activeMode === "rendered" && interpretation.kind === "messages" ? (
        <div className="payload-scroll flex flex-col gap-2 p-2.5">
          {interpretation.messages.map((message, index) => (
            <MessageView key={`${message.role}-${index}`} message={message} />
          ))}
          <CanonicalNotice />
        </div>
      ) : activeMode === "rendered" && interpretation.kind === "choices" ? (
        <div className="payload-scroll flex flex-col gap-2 p-2.5">
          {interpretation.choices.map((choice, position) => (
            <ChoiceView key={`${choice.index ?? position}-${position}`} choice={choice} position={position} />
          ))}
          <CanonicalNotice />
        </div>
      ) : stringPresentation !== null && activeMode !== "raw" ? (
        <PayloadText text={activeMode === "pretty" ? stringPresentation.prettyText ?? stringPresentation.sourceText : stringPresentation.sourceText} />
      ) : (
        <pre className="payload-scroll payload-json p-3 font-mono text-[11px] leading-5">
          {stringPresentation?.rawJsonText ?? rawText}
        </pre>
      )}
    </div>
  );
}

function PayloadText({ text }: { text: string }) {
  if (text.length === 0) {
    return <div className="payload-scroll p-3 text-[11.5px] italic text-ink-4">Empty string</div>;
  }
  return (
    <pre className="payload-scroll payload-json p-3 font-mono text-[11px] leading-5">
      {text}
    </pre>
  );
}

function HumanText({ value }: { value: string }) {
  const renderMarkdown = useMemo(() => looksLikeMarkdown(value), [value]);
  return renderMarkdown ? (
    <MarkdownBody source={value} />
  ) : (
    <div className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-ink-2">{value}</div>
  );
}

function stringPayloadLabel(presentation: ReturnType<typeof presentStringPayload>): string {
  if (presentation.renderedKind === "json") return "JSON string payload";
  if (presentation.renderedKind === "markdown") {
    return presentation.markdownDetected ? "Detected Markdown string" : "String payload · Markdown available";
  }
  if (presentation.markdownUnavailableReason) return "String payload · Source only";
  return "String payload";
}

function ChoiceView({ choice, position }: { choice: PayloadChoice; position: number }) {
  return (
    <section className="rounded-sm border border-rule bg-paper-2 p-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-4">
        <span>Choice {choice.index ?? position}</span>
        {choice.finishReason ? <span>Finish · {choice.finishReason}</span> : null}
      </div>
      <MessageView message={choice.message} />
    </section>
  );
}

function CanonicalNotice() {
  return (
    <div className="font-mono text-[9.5px] leading-4 text-ink-4">
      Interpreted view. JSON is complete and authoritative.
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  children,
  title
}: {
  active: boolean;
  onClick: () => void;
  children: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "min-h-6 cursor-pointer rounded-[1px] px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3",
        active && "bg-card text-ink shadow-[var(--shadow-card)]"
      )}
    >
      {children}
    </button>
  );
}

function MessageView({ message }: { message: PayloadMessage }) {
  const hasContent = message.content !== null && message.content !== undefined && message.content !== "";

  return (
    <section className="rounded-sm border border-rule-soft bg-card px-2.5 py-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={roleVariant(message.role)}>{message.role}</Badge>
        {message.name ? <span className="font-mono text-[10px] text-ink-3">{message.name}</span> : null}
        {message.toolCallId ? (
          <span className="font-mono text-[9.5px] text-ink-4">call {message.toolCallId}</span>
        ) : null}
      </div>

      {hasContent ? <ContentView value={message.content} format={message.contentFormat} /> : null}
      {message.toolCalls.length > 0 ? (
        <div className={cn("flex flex-col gap-1.5", hasContent && "mt-2")}>
          {message.toolCalls.map((toolCall, index) => (
            <ToolCallView key={`${toolCall.id ?? toolCall.name}-${index}`} toolCall={toolCall} />
          ))}
        </div>
      ) : null}
      {message.unrecognizedToolCalls.length > 0 ? (
        <div className={cn("flex flex-col gap-1.5", (hasContent || message.toolCalls.length > 0) && "mt-2")}>
          {message.unrecognizedToolCalls.map((toolCall, index) => (
            <div key={index}>
              <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-4">
                Unrecognized tool call
              </div>
              <CompactJson value={toolCall} />
            </div>
          ))}
        </div>
      ) : null}
      {!hasContent && message.toolCalls.length === 0 && message.unrecognizedToolCalls.length === 0 ? (
        <div className="text-[11.5px] italic text-ink-4">No displayable content. See JSON.</div>
      ) : null}
    </section>
  );
}

function ContentView({ value, format }: { value: unknown; format: "legacy" | "otel" }) {
  if (typeof value === "string") {
    return <HumanText value={value} />;
  }

  if (Array.isArray(value)) {
    return (
      <div className="flex flex-col gap-1.5">
        {value.map((part, index) => (
          <ContentPart key={index} value={part} format={format} />
        ))}
      </div>
    );
  }

  return <CompactJson value={value} />;
}

function ContentPart({ value, format }: { value: unknown; format: "legacy" | "otel" }) {
  if (typeof value === "string") {
    return <HumanText value={value} />;
  }
  if (format === "legacy") {
    if (isRecord(value) && typeof value.text === "string" && ["text", "input_text", "output_text"].includes(String(value.type))) {
      return <HumanText value={value.text} />;
    }
    return <CompactJson value={value} />;
  }

  if (isRecord(value) && value.type === "text" && typeof value.content === "string") {
    return <HumanText value={value.content} />;
  }
  if (isRecord(value) && value.type === "tool_call" && typeof value.name === "string") {
    return (
      <ToolCallView
        toolCall={{
          id: typeof value.id === "string" ? value.id : null,
          name: value.name,
          arguments: value.arguments
        }}
      />
    );
  }
  if (isRecord(value) && value.type === "tool_call_response" && "response" in value) {
    return (
      <div className="rounded-sm border border-rule bg-paper-2 p-2">
        <div className="mb-1.5 font-mono text-[10.5px] font-medium text-ink-2">
          tool result{typeof value.id === "string" ? ` · ${value.id}` : ""}
        </div>
        {typeof value.response === "string" ? (
          <HumanText value={value.response} />
        ) : (
          <CompactJson value={value.response} />
        )}
      </div>
    );
  }
  return <CompactJson value={value} />;
}

function ToolCallView({ toolCall }: { toolCall: PayloadToolCall }) {
  return (
    <div className="rounded-sm border border-rule bg-paper-2 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] font-medium text-ink-2">tool · {toolCall.name}</span>
        {toolCall.id ? <span className="font-mono text-[9.5px] text-ink-4">{toolCall.id}</span> : null}
      </div>
      {toolCall.arguments !== undefined ? <div className="mt-1.5"><ToolArguments value={toolCall.arguments} /></div> : null}
    </div>
  );
}

function ToolArguments({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <pre className="overflow-auto rounded-sm border border-rule-soft bg-card-2 p-2 font-mono text-[10.5px] leading-[1.55] whitespace-pre-wrap break-all">
        {value}
      </pre>
    );
  }
  return <CompactJson value={value} />;
}

function CompactJson({ value }: { value: unknown }) {
  return (
    <pre className="overflow-auto rounded-sm border border-rule-soft bg-card-2 p-2 font-mono text-[10.5px] leading-[1.55] whitespace-pre-wrap break-all">
      {stringifyPayload(value)}
    </pre>
  );
}

function roleVariant(role: string): "default" | "signal" | "ok" {
  if (role === "user") return "signal";
  if (role === "assistant") return "ok";
  return "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
