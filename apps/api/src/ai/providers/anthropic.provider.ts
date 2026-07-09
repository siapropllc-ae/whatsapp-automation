import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { type AiProvider, AiProviderError } from '../ai.service';

export class AnthropicProvider implements AiProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model = 'claude-haiku-4-5', timeoutMs = 30_000) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { timeout: this.timeoutMs },
      );
    } catch (err) {
      throw this.toProviderError(err);
    }

    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') {
      throw new AiProviderError('Anthropic returned no text block', false, { cause: response });
    }
    return block.text;
  }

  /**
   * Classifies an SDK failure as retryable (network/timeout with no status, 429, or 5xx —
   * the SDK's own maxRetries already exhausted its internal backoff for these) vs.
   * non-retryable (4xx like bad request/auth — retrying identical input will never help).
   */
  private toProviderError(err: unknown): AiProviderError {
    if (err instanceof APIError) {
      const retryable = err.status === undefined || err.status === 429 || err.status >= 500;
      return new AiProviderError(
        `Anthropic API error (status=${err.status ?? 'network'}): ${err.message}`,
        retryable,
        { cause: err },
      );
    }
    return new AiProviderError(`Anthropic request failed: ${String(err)}`, true, { cause: err });
  }
}
