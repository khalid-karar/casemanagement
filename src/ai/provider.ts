/**
 * Model-agnostic chat provider for any OpenAI-compatible endpoint (vLLM, SGLang). The model is
 * configuration, not code: swap Qwen for Falcon-H1 Arabic or Jais by changing `model`.
 * PDPL Art. 29: inference must stay in the Kingdom, so only allow-listed hosts are callable.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatProvider {
  readonly model: string;
  complete(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

export class ProviderConfigError extends Error {}

export interface OpenAICompatConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Hostnames inference may run on (in-Kingdom GPU hosts). Required, never defaulted. */
  allowedHosts: string[];
  /** Header carrying the key. Default `authorization: Bearer <key>`; some clouds use e.g. `api-key`. */
  authHeader?: string;
  fetchImpl?: typeof fetch;
}

/** Reasoning models emit <think>…</think>; it is never shown to users or stored as the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
}

export function openAICompatProvider(cfg: OpenAICompatConfig): ChatProvider {
  const url = new URL(cfg.baseUrl);
  if (cfg.allowedHosts.length === 0) throw new ProviderConfigError('allowedHosts must be set');
  if (!cfg.allowedHosts.includes(url.hostname)) {
    throw new ProviderConfigError(`Host ${url.hostname} is not an approved in-Kingdom inference host`);
  }
  const doFetch = cfg.fetchImpl ?? fetch;
  return {
    model: cfg.model,
    async complete(messages, opts = {}) {
      const res = await doFetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? (cfg.authHeader ? { [cfg.authHeader]: cfg.apiKey } : { authorization: `Bearer ${cfg.apiKey}` }) : {}) },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 1024,
        }),
      });
      if (!res.ok) throw new Error(`Inference failed: HTTP ${res.status}`);
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return stripThinking(json.choices?.[0]?.message?.content ?? '');
    },
  };
}
