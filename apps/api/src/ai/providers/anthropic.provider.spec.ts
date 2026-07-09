import { APIError } from '@anthropic-ai/sdk';
import { AnthropicProvider } from './anthropic.provider';
import { AiProviderError } from '../ai.service';

const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk');
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    APIError: actual.APIError,
  };
});

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new AnthropicProvider('test-key', 'claude-haiku-4-5', 5_000);
  });

  it('passes the configured timeout as a per-request option', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hello' }] });
    await provider.complete('sys', 'user');
    expect(mockCreate).toHaveBeenCalledWith(expect.any(Object), { timeout: 5_000 });
  });

  it('returns the text block content', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hello world' }] });
    const result = await provider.complete('sys', 'user');
    expect(result).toBe('hello world');
  });

  it('throws a non-retryable AiProviderError when no text block is returned', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'image', source: {} }] });
    await expect(provider.complete('sys', 'user')).rejects.toMatchObject({
      retryable: false,
    });
    await expect(provider.complete('sys', 'user')).rejects.toBeInstanceOf(AiProviderError);
  });

  // Regression coverage for Gap 6: a raw SDK error must never propagate unwrapped — every
  // failure path becomes a typed AiProviderError with a retryable classification the caller
  // (AiService.callProvider) uses to decide the response, instead of an unhandled 500 that
  // could leak SDK-internal error shapes.
  it('classifies a 429 rate-limit error as retryable', async () => {
    mockCreate.mockRejectedValue(new APIError(429, { message: 'rate limited' }, 'rate limited', undefined));
    await expect(provider.complete('sys', 'user')).rejects.toMatchObject({ retryable: true });
  });

  it('classifies a 500 server error as retryable', async () => {
    mockCreate.mockRejectedValue(new APIError(500, { message: 'server error' }, 'server error', undefined));
    await expect(provider.complete('sys', 'user')).rejects.toMatchObject({ retryable: true });
  });

  it('classifies a connection error (no status) as retryable', async () => {
    mockCreate.mockRejectedValue(new APIError(undefined, undefined, 'network unreachable', undefined));
    await expect(provider.complete('sys', 'user')).rejects.toMatchObject({ retryable: true });
  });

  it('classifies a 400 bad-request error as non-retryable', async () => {
    mockCreate.mockRejectedValue(new APIError(400, { message: 'invalid request' }, 'invalid request', undefined));
    await expect(provider.complete('sys', 'user')).rejects.toMatchObject({ retryable: false });
  });

  it('classifies a 401 auth error as non-retryable', async () => {
    mockCreate.mockRejectedValue(new APIError(401, { message: 'invalid api key' }, 'invalid api key', undefined));
    await expect(provider.complete('sys', 'user')).rejects.toMatchObject({ retryable: false });
  });

  it('wraps a non-APIError throw (e.g. a raw JS error) as retryable', async () => {
    mockCreate.mockRejectedValue(new Error('unexpected'));
    await expect(provider.complete('sys', 'user')).rejects.toMatchObject({ retryable: true });
    await expect(provider.complete('sys', 'user')).rejects.toBeInstanceOf(AiProviderError);
  });
});
