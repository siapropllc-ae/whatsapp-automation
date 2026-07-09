import OpenAI, { APIError } from 'openai';
import { type AiProvider, AiProviderError } from '../ai.service';

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model = 'gpt-4o', timeoutMs = 30_000) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
        },
        { timeout: this.timeoutMs },
      );
    } catch (err) {
      throw this.toProviderError(err);
    }

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new AiProviderError('OpenAI returned no message content', false, { cause: response });
    }
    return content;
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
        `OpenAI API error (status=${err.status ?? 'network'}): ${err.message}`,
        retryable,
        { cause: err },
      );
    }
    return new AiProviderError(`OpenAI request failed: ${String(err)}`, true, { cause: err });
  }
}
