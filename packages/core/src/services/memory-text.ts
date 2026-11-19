/** The text both models read for a memory: the curated title, a blank line, then the content. */
export function memoryText(title: string, content: string): string {
  return `${title}\n\n${content}`;
}
