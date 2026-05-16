/**
 * Phase-1 token estimate: ceil(chars / 3). Cheap, model-agnostic, deliberately
 * pessimistic. See dev-notes/03-llm-providers.md.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
