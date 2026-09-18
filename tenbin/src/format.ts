/** Every tool returns the same JSON twice: as `content` text for clients that only read text, and as `structuredContent`. */
export function toolResult(structured: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }], structuredContent: structured, ...(isError ? { isError: true } : {}) };
}

export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}
