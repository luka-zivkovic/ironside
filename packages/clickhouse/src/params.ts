/**
 * ClickHouse's HTTP interface rejects a query parameter longer than
 * http_max_field_value_size (128 KiB by default). Identifiers can be up to 512
 * bytes, so lists of them are split by size, not by count, with room left for
 * quoting and escaping.
 */
export const MAX_PARAM_BYTES = 64 * 1024;

/**
 * Splits `items` into consecutive chunks in which each parameter built from
 * them stays under MAX_PARAM_BYTES. `params` maps an item to the value it adds
 * to each parameter, or "" when it adds nothing to that one.
 */
export function chunkByParamBytes<T>(items: T[], params: ((item: T) => string)[]): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let sizes = params.map(() => 0);
  for (const item of items) {
    const added = params.map((param) => {
      const value = param(item);
      return value === "" ? 0 : Buffer.byteLength(value) + 4;
    });
    if (chunk.length > 0 && added.some((bytes, index) => sizes[index]! + bytes > MAX_PARAM_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      sizes = params.map(() => 0);
    }
    chunk.push(item);
    sizes = sizes.map((size, index) => size + added[index]!);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
