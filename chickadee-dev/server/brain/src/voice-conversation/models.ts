// models.ts — model → provider + per-provider token budgets.
//
// Ported VERBATIM from console-ai-client.js _providerForModel (43–53), _maxTokensForProvider (59–67).
// Difference: the console consults window.AiModelCatalog for authoritative lookup; that catalog is
// not available server-side, so the brain relies on prefix-sniff only. The catalog was added to fix
// a Nova→Anthropic misroute; the prefix-sniff below already handles Nova via the `nova` check.
// TODO(later): a server-side model→provider catalog if prefix-sniff proves insufficient.

export type Provider = 'claude' | 'openai' | 'gemini' | 'bedrock';

export function providerForModel(modelId: string): Provider {
  if (!modelId || typeof modelId !== 'string') return 'claude';
  const id = modelId.toLowerCase();
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3')) return 'openai';
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('us.amazon.') || id.startsWith('bedrock-') || id.includes('nova')) return 'bedrock';
  return 'claude';
}

// Per-provider max_tokens — matches webapp ai-context.js AI_CONFIG. Gemini gets a much larger
// budget because search-result synthesis often blows past 1500 tokens; truncation mid-JSON makes
// the parser fail and renders literal half-finished JSON.
export function maxTokensForProvider(provider: string): number {
  switch (provider) {
    case 'claude': return 1500;
    case 'openai': return 1500;
    case 'gemini': return 50000;
    case 'bedrock': return 5000;
    default: return 2048;
  }
}
