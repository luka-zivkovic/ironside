/**
 * ClickHouse's HTTP interface rejects a query parameter whose value, as sent,
 * is longer than http_max_field_value_size (128 KiB by default). The client
 * sends parameters URL-encoded, where a non-ASCII byte takes three characters
 * and an escaped quote six, so the budget counts each value's encoded length,
 * with room to spare.
 */
export const MAX_PARAM_LENGTH = 96 * 1024;

/** The length `value` adds to an Array(String) parameter once quoted, escaped as the client does, and URL-encoded. */
export function encodedParamLength(value: string): number {
  const escaped = value
    .replace(/[\\']/g, "\\$&")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return new URLSearchParams([["p", `'${escaped}',`]]).toString().length - "p=".length;
}

/**
 * Splits `items` into consecutive chunks in which each parameter built from
 * them stays under MAX_PARAM_LENGTH. `params` maps an item to the value it
 * adds to each parameter, or "" when it adds nothing to that one; a value
 * already in the chunk's parameter adds nothing again, since parameters are
 * sent without duplicates.
 */
export function chunkByParamBytes<T>(items: T[], params: ((item: T) => string)[]): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let sizes = params.map(() => 0);
  let seen = params.map(() => new Set<string>());
  for (const item of items) {
    const values = params.map((param) => param(item));
    const added = values.map((value, index) =>
      value === "" || seen[index]!.has(value) ? 0 : encodedParamLength(value)
    );
    if (chunk.length > 0 && added.some((length, index) => sizes[index]! + length > MAX_PARAM_LENGTH)) {
      chunks.push(chunk);
      chunk = [];
      sizes = params.map(() => 0);
      seen = params.map(() => new Set<string>());
      values.forEach((value, index) => (added[index] = value === "" ? 0 : encodedParamLength(value)));
    }
    chunk.push(item);
    values.forEach((value, index) => {
      if (value !== "") seen[index]!.add(value);
    });
    sizes = sizes.map((size, index) => size + added[index]!);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
