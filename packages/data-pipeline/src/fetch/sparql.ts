/** `value` escaped for a double-quoted SPARQL string: backslashes first, then quotes and newlines. */
export function sparqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
