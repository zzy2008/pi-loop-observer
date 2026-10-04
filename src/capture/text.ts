/** Pi user messages may contain text blocks rather than a string. */
export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join(" ");
}
