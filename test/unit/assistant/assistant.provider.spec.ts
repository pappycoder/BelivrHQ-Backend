import { ConfigService } from '@nestjs/config';
import { AssistantProvider } from '../../../src/assistant/assistant.provider';
const settings = {
  ASK_BELIVRHQ_AI_ENABLED: 'true',
  OPENAI_API_KEY: 'test-only-key',
  ASK_BELIVRHQ_MODEL: 'test-model',
  ASK_BELIVRHQ_INPUT_USD_PER_MILLION: '1',
  ASK_BELIVRHQ_OUTPUT_USD_PER_MILLION: '2',
};
const create = (overrides = {}) =>
  new AssistantProvider({
    get: (key: string) => ({ ...settings, ...overrides })[key as keyof typeof settings],
  } as ConfigService);
const sources = [{ id: 'policy:tables', title: 'Table controls', text: 'Compact body rows.' }];
function response(answer: unknown, status = 'completed') {
  return new Response(
    JSON.stringify({
      status,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(answer) }],
        },
      ],
    }),
  );
}
describe('OpenAI provider boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  it('requires an explicit opt-in, key, model and positive cost configuration', () => {
    expect(create().configured).toBe(true);
    for (const overrides of [
      { ASK_BELIVRHQ_AI_ENABLED: 'false' },
      { OPENAI_API_KEY: '' },
      { ASK_BELIVRHQ_MODEL: '' },
      { ASK_BELIVRHQ_INPUT_USD_PER_MILLION: 'NaN' },
      { ASK_BELIVRHQ_OUTPUT_USD_PER_MILLION: '0' },
    ])
      expect(create(overrides).configured).toBe(false);
  });
  it('uses a stateless Responses call with bounded output, no tools, no credentials in prompts, and strict structured output', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(response({ answer: 'Use Table view.', sources: ['policy:tables'] }));
    const provider = create();
    const body = provider.request('How do tables work?', [], { page: '/forms' }, sources);
    const answer = await provider.answer(body, sources);
    expect(answer.answer).toBe('Use Table view.');
    expect(body).toMatchObject({
      store: false,
      max_output_tokens: 450,
      text: { format: { strict: true, type: 'json_schema' } },
    });
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body)).not.toContain('test-only-key');
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
    expect(provider.reserveCost(body)).toBeGreaterThan(5000);
  });
  it.each([
    { answer: 'An invented answer.', sources: ['invented'] },
    { answer: 'Read https://evil.test', sources: ['policy:tables'] },
    { answer: '<script>alert(1)</script>', sources: ['policy:tables'] },
    { answer: 'I have deleted your records.', sources: ['policy:tables'] },
    { answer: '', sources: ['policy:tables'] },
    { answer: 'No citations.', sources: [] },
    { answer: 'Unnecessarily verbose answer. '.repeat(50), sources: ['policy:tables'] },
  ])(
    'rejects unverified references, active content and fabricated action claims',
    async (value) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(response(value));
      const provider = create();
      await expect(
        provider.answer(provider.request('Tables', [], {}, sources), sources),
      ).rejects.toThrow();
    },
  );
  it('rejects incomplete generation and HTTP failures without exposing provider errors', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        response({ answer: 'Cut short', sources: ['policy:tables'] }, 'incomplete'),
      )
      .mockResolvedValueOnce(new Response('secret upstream error', { status: 429 }));
    const provider = create();
    const body = provider.request('Tables', [], {}, sources);
    await expect(provider.answer(body, sources)).rejects.toThrow('Incomplete');
    await expect(provider.answer(body, sources)).rejects.toThrow('Assistant unavailable');
  });
});
