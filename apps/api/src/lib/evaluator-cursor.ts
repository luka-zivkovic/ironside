import { z } from "zod";

const bootstrapCursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal("bootstrap"),
  through: z.iso.datetime({ offset: true }),
  afterVersion: z.iso.datetime({ offset: true }),
  afterTraceId: z.string().min(1)
});

const liveCursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal("live"),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  traceId: z.string().min(1).nullable()
}).refine((value) => (value.publishedAt === null) === (value.traceId === null));

export const evaluatorCursorSchema = z.discriminatedUnion("kind", [
  bootstrapCursorSchema,
  liveCursorSchema
]);
export type EvaluatorCursor = z.infer<typeof evaluatorCursorSchema>;

export function encodeEvaluatorCursor(cursor: EvaluatorCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeEvaluatorCursor(value: string): EvaluatorCursor | null {
  try {
    return evaluatorCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    );
  } catch {
    return null;
  }
}

export function initialLiveEvaluatorCursor(): EvaluatorCursor {
  return { v: 1, kind: "live", publishedAt: null, traceId: null };
}
