import { describe, expect, it } from 'vitest';
import { configuredAutonomyLoop } from '../src/mind/action/ownTime/autonomyLoopConfig.js';
import { sharesLongPassage } from '../src/mind/action/ownTime/autonomyLoopSteps.js';
import { planFromThought } from '../src/mind/action/ownTime/autonomyLoopPlan.js';
import { BoundedPublicReader, htmlToText, parseRobots, robotsAllows } from '../src/mind/action/ownTime/autonomyReader.js';
import {
  AUTONOMY_CREDENTIAL_VARIABLES, AutonomyModelError, autonomyPromptCacheKey, configuredAutonomyTextModel, dedicatedAutonomyCredential, resolveAutonomyModel,
} from '../src/mind/action/ownTime/autonomyTextModel.js';

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { calls, fetcher };
}

const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const publicLookup = async () => [{ address: '93.184.216.34' }];

describe('bounded public reader', () => {
  it('reads one public page as text, with its title and a few links', async () => {
    const { calls, fetcher } = fakeFetch(url => (url.endsWith('/robots.txt') ? new Response('', { status: 404 })
      : html('<html><head><title>夕方の駅 &amp; 光</title><style>p{}</style></head><body><nav>メニュー</nav><main><h1>夕方の駅</h1><p>光が低く差しこむ。</p><script>alert(1)</script><a href="/next?x=1#top">次の随筆を読む</a><a href="javascript:alert(1)">だめなリンク</a><a href="mailto:a@example.org">メールを送る</a></main></body></html>')));
    const reader = new BoundedPublicReader({ fetcher, lookup: publicLookup });
    const page = await reader.read('https://example.org/essay#section');
    expect(page).toEqual({
      url: 'https://example.org/essay', title: '夕方の駅 & 光', text: '夕方の駅\n光が低く差しこむ。\n次の随筆を読む だめなリンク メールを送る',
      links: [{ title: '次の随筆を読む', url: 'https://example.org/next?x=1' }],
    });
    expect(calls.map(call => call.url)).toEqual(['https://example.org/robots.txt', 'https://example.org/essay']);
    // No cookie, no credential, no body: a plain read.
    for (const call of calls) {
      expect(call.init.method).toBeUndefined();
      expect(call.init.body).toBeUndefined();
      expect(Object.keys(call.init.headers as Record<string, string>).sort()).not.toContain('cookie');
      expect(call.init.redirect).toBe('manual');
      expect((call.init.headers as Record<string, string>)['user-agent']).toContain('ShannonStudy');
    }
  });

  it('refuses anything but a public http(s) address, before any request', async () => {
    const { calls, fetcher } = fakeFetch(() => html('x'));
    const reader = new BoundedPublicReader({ fetcher, lookup: async host => (host === 'rebind.example' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }]) });
    for (const url of ['file:///etc/passwd', 'ftp://example.org/x', 'https://user:pw@example.org/', 'not a url']) {
      await expect(reader.read(url)).rejects.toThrow('AUTONOMY_READ_URL_INVALID');
    }
    for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://[::1]/x', 'http://169.254.169.254/latest/meta-data', 'http://192.168.1.1/', 'https://nas.local/', 'https://rebind.example/']) {
      await expect(reader.read(url), url).rejects.toThrow('AUTONOMY_READ_NOT_PUBLIC');
    }
    expect(calls).toHaveLength(0);
  });

  it('checks every redirect hop again and stops after three', async () => {
    const hops = fakeFetch(url => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      if (url === 'https://example.org/start') return new Response(null, { status: 302, headers: { location: 'http://10.0.0.8/internal' } });
      return html('x');
    });
    await expect(new BoundedPublicReader({ fetcher: hops.fetcher, lookup: publicLookup }).read('https://example.org/start')).rejects.toThrow('AUTONOMY_READ_NOT_PUBLIC');
    expect(hops.calls.map(call => call.url)).not.toContain('http://10.0.0.8/internal');

    const loop = fakeFetch(url => (url.endsWith('/robots.txt') ? new Response('', { status: 404 })
      : new Response(null, { status: 301, headers: { location: `${url}x` } })));
    await expect(new BoundedPublicReader({ fetcher: loop.fetcher, lookup: publicLookup }).read('https://example.org/a')).rejects.toThrow('AUTONOMY_READ_REDIRECT_LIMIT');
    expect(loop.calls.filter(call => !call.url.endsWith('/robots.txt'))).toHaveLength(4);
  });

  it('respects robots.txt, and does not read when robots.txt cannot be fetched', async () => {
    const robots = 'User-agent: *\nDisallow: /private/\nAllow: /private/open\n\nUser-agent: ShannonStudy\nDisallow: /no-shannon';
    const { calls, fetcher } = fakeFetch(url => (url.endsWith('/robots.txt') ? new Response(robots, { status: 200 }) : html('<p>本文</p>')));
    const reader = new BoundedPublicReader({ fetcher, lookup: publicLookup });
    await expect(reader.read('https://example.org/no-shannon/page')).rejects.toThrow('AUTONOMY_READ_ROBOTS_DISALLOWED');
    // Her own group replaces `*`, as the standard says.
    expect((await reader.read('https://example.org/private/x')).text).toBe('本文');
    // robots.txt is fetched once per site, not once per page.
    expect(calls.filter(call => call.url.endsWith('/robots.txt'))).toHaveLength(1);

    const broken = fakeFetch(url => (url.endsWith('/robots.txt') ? new Response('oops', { status: 503 }) : html('x')));
    await expect(new BoundedPublicReader({ fetcher: broken.fetcher, lookup: publicLookup }).read('https://example.org/x')).rejects.toThrow('AUTONOMY_READ_ROBOTS_DISALLOWED');
    expect(broken.calls.map(call => call.url)).toEqual(['https://example.org/robots.txt']);
  });

  it('parses robots rules: longest match wins, allow on a tie, wildcards and anchors', () => {
    const rules = parseRobots('# comment\nUser-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /*.pdf$\nDisallow:\n\nUser-agent: other\nDisallow: /');
    expect(robotsAllows(rules, '/')).toBe(true);
    expect(robotsAllows(rules, '/a/x')).toBe(false);
    expect(robotsAllows(rules, '/a/b/c')).toBe(true);
    expect(robotsAllows(rules, '/files/x.pdf')).toBe(false);
    expect(robotsAllows(rules, '/files/x.pdf?download=1')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /'), '/anything')).toBe(false);
    expect(robotsAllows(parseRobots(''), '/anything')).toBe(true);
  });

  it('caps the size, the time, and the kind of content', async () => {
    const robots = (url: string) => url.endsWith('/robots.txt');
    const big = fakeFetch(url => (robots(url) ? new Response('', { status: 404 }) : html('あ'.repeat(5_000))));
    await expect(new BoundedPublicReader({ fetcher: big.fetcher, lookup: publicLookup, maximumBytes: 1_000 }).read('https://example.org/big')).rejects.toThrow('AUTONOMY_READ_TOO_LARGE');
    const declared = fakeFetch(url => (robots(url) ? new Response('', { status: 404 }) : html('x', { 'content-length': '99999999' })));
    await expect(new BoundedPublicReader({ fetcher: declared.fetcher, lookup: publicLookup }).read('https://example.org/big')).rejects.toThrow('AUTONOMY_READ_TOO_LARGE');
    const binary = fakeFetch(url => (robots(url) ? new Response('', { status: 404 }) : new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } })));
    await expect(new BoundedPublicReader({ fetcher: binary.fetcher, lookup: publicLookup }).read('https://example.org/file')).rejects.toThrow('AUTONOMY_READ_NOT_TEXT');
    const missing = fakeFetch(url => (robots(url) ? new Response('', { status: 404 }) : new Response('no', { status: 404 })));
    await expect(new BoundedPublicReader({ fetcher: missing.fetcher, lookup: publicLookup }).read('https://example.org/none')).rejects.toThrow('AUTONOMY_READ_HTTP_404');
    const long = fakeFetch(url => (robots(url) ? new Response('', { status: 404 }) : html(`<p>${'長い文。'.repeat(5_000)}</p>`)));
    expect((await new BoundedPublicReader({ fetcher: long.fetcher, lookup: publicLookup }).read('https://example.org/long')).text).toHaveLength(6_000);
    const slow = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await expect(new BoundedPublicReader({ fetcher: slow.fetcher, lookup: publicLookup, timeoutMilliseconds: 20 }).read('https://example.org/slow')).rejects.toThrow();
  });

  it('turns markup into plain text without scripts or styles', () => {
    expect(htmlToText('<div>一行目<br>二行目</div><script>x()</script><style>.a{}</style><p>三行目&nbsp;&#x3042;&#12356;</p>')).toBe('一行目\n二行目\n三行目 あい');
  });
});

describe('model adapters for her own activity', () => {
  const environment = { [AUTONOMY_CREDENTIAL_VARIABLES.google]: 'dedicated-gemini-credential', [AUTONOMY_CREDENTIAL_VARIABLES.openai]: 'dedicated-openai-credential' };

  it('takes the credential only from the dedicated variables, never from the conversation keys', () => {
    expect(AUTONOMY_CREDENTIAL_VARIABLES).toEqual({ google: 'SHANNON_AUTONOMY_GEMINI_API_KEY', openai: 'SHANNON_AUTONOMY_OPENAI_API_KEY' });
    const conversationOnly = configuredAutonomyTextModel({ OPENAI_API_KEY: 'conversation-openai', GEMINI_API_KEY: 'conversation-gemini' });
    expect(conversationOnly.configuredProviders).toEqual([]);
    expect(conversationOnly.canUse('gemini-3.8-flash')).toBe(false);
    expect(conversationOnly.canUse('gpt-5.6-luna')).toBe(false);
    // A dedicated variable that only repeats the conversation key is not a dedicated credential.
    expect(dedicatedAutonomyCredential('openai', { OPENAI_API_KEY: 'same', SHANNON_AUTONOMY_OPENAI_API_KEY: 'same' })).toBeNull();
    expect(dedicatedAutonomyCredential('google', { GEMINI_API_KEY: 'conversation', SHANNON_AUTONOMY_GEMINI_API_KEY: ' dedicated ' })).toBe('dedicated');
    const geminiOnly = configuredAutonomyTextModel({ SHANNON_AUTONOMY_GEMINI_API_KEY: 'dedicated', OPENAI_API_KEY: 'conversation-openai' });
    expect(geminiOnly.configuredProviders).toEqual(['google']);
    expect(geminiOnly.canUse('gpt-5.6-terra')).toBe(false);
    expect(geminiOnly.canUse('some-other-model')).toBe(false);
  });

  it('calls Gemini with the dedicated key and reports reasoning tokens as output', async () => {
    const { calls, fetcher } = fakeFetch(() => Response.json({
      candidates: [{ content: { parts: [{ text: '考え中', thought: true }, { text: '{"title":"題"}' }] } }],
      usageMetadata: { promptTokenCount: 1_200, candidatesTokenCount: 300, thoughtsTokenCount: 150, totalTokenCount: 1_650 },
    }));
    const model = configuredAutonomyTextModel({ ...environment, GEMINI_API_KEY: 'conversation-gemini', OPENAI_API_KEY: 'conversation-openai' }, fetcher);
    const result = await model.generate({ model: 'gemini-3.8-flash', system: '規則', prompt: '材料', maximumOutputTokens: 900 });
    expect(result).toEqual({ text: '{"title":"題"}', usage: { inputTokens: 1_200, outputTokens: 450 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(calls[0]!.init.headers).toEqual({ 'x-goog-api-key': 'dedicated-gemini-credential', 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      systemInstruction: { parts: [{ text: '規則' }] }, contents: [{ role: 'user', parts: [{ text: '材料' }] }],
      generationConfig: { maxOutputTokens: 900, responseMimeType: 'application/json' },
    });
    expect(JSON.stringify(calls)).not.toContain('conversation-');
  });

  it('calls OpenAI with the dedicated key and without storing the response', async () => {
    const { calls, fetcher } = fakeFetch(() => Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"steps":[]}' }] }], usage: { input_tokens: 800, output_tokens: 90 },
    }));
    const model = configuredAutonomyTextModel({ ...environment, OPENAI_API_KEY: 'conversation-openai' }, fetcher);
    const result = await model.generate({ model: 'gpt-5.6-luna', system: '規則', prompt: '材料', maximumOutputTokens: 500 });
    expect(result).toEqual({ text: '{"steps":[]}', usage: { inputTokens: 800, outputTokens: 90 } });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.init.headers).toEqual({ authorization: 'Bearer dedicated-openai-credential', 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: 'gpt-5.6-luna', instructions: '規則', input: '材料', text: { format: { type: 'json_object' } }, max_output_tokens: 500, store: false,
      // Routed by a digest of the system text, as the conversation routes by a digest of its scope.
      prompt_cache_key: autonomyPromptCacheKey('規則'),
    });
    expect(autonomyPromptCacheKey('規則')).toMatch(/^shannon_autonomy_[0-9a-f]{32}$/u);
    expect(autonomyPromptCacheKey('規則')).not.toBe(autonomyPromptCacheKey('別の規則'));
  });

  it('records what each provider read from its prompt cache, and charges nothing less for it', async () => {
    const openai = fakeFetch(() => Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"steps":[]}' }] }],
      usage: { input_tokens: 800, output_tokens: 90, input_tokens_details: { cached_tokens: 512 } },
    }));
    expect(await configuredAutonomyTextModel(environment, openai.fetcher).generate({ model: 'gpt-5.6-luna', system: '規則', prompt: '材料', maximumOutputTokens: 500 }))
      .toEqual({ text: '{"steps":[]}', usage: { inputTokens: 800, outputTokens: 90, cachedInputTokens: 512 } });
    const gemini = fakeFetch(() => Response.json({
      candidates: [{ content: { parts: [{ text: '{"steps":[]}' }] } }],
      usageMetadata: { promptTokenCount: 1_200, cachedContentTokenCount: 1_024, candidatesTokenCount: 30 },
    }));
    expect(await configuredAutonomyTextModel(environment, gemini.fetcher).generate({ model: 'gemini-3.8-flash', system: '規則', prompt: '材料', maximumOutputTokens: 500 }))
      .toEqual({ text: '{"steps":[]}', usage: { inputTokens: 1_200, outputTokens: 30, cachedInputTokens: 1_024 } });
  });

  it('says when the provider cut the reply off at the output ceiling, also when reasoning used all of it', async () => {
    // Gemini: reasoning tokens count against maxOutputTokens, so 1,500 can be reached with half a JSON object written.
    const cut = fakeFetch(() => Response.json({
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"thought":"直します。","steps":[{"action":"rev' }] } }],
      usageMetadata: { promptTokenCount: 4_600, candidatesTokenCount: 420, thoughtsTokenCount: 1_080 },
    }));
    expect(await configuredAutonomyTextModel(environment, cut.fetcher).generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 1_500 }))
      .toEqual({ text: '{"thought":"直します。","steps":[{"action":"rev', usage: { inputTokens: 4_600, outputTokens: 1_500 }, truncated: true });
    const nothing = fakeFetch(() => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }], usageMetadata: { promptTokenCount: 4_600, thoughtsTokenCount: 1_500 } }));
    const error = await configuredAutonomyTextModel(environment, nothing.fetcher)
      .generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 1_500 }).catch(caught => caught as AutonomyModelError);
    // Nothing was written, and the call is still charged what the provider counted.
    expect(error).toMatchObject({ code: 'AUTONOMY_MODEL_TRUNCATED', usage: { inputTokens: 4_600, outputTokens: 1_500 } });
    const whole = fakeFetch(() => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"steps":[]}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
    expect(await configuredAutonomyTextModel(environment, whole.fetcher).generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 100 }))
      .toEqual({ text: '{"steps":[]}', usage: { inputTokens: 10, outputTokens: 5 } });
    const incomplete = fakeFetch(() => Response.json({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"steps":[{"act' }] }], usage: { input_tokens: 800, output_tokens: 500 },
    }));
    expect(await configuredAutonomyTextModel(environment, incomplete.fetcher).generate({ model: 'gpt-5.6-luna', system: 's', prompt: 'p', maximumOutputTokens: 500 }))
      .toMatchObject({ truncated: true, usage: { inputTokens: 800, outputTokens: 500 } });
    const reasoned = fakeFetch(() => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 800, output_tokens: 500 } }));
    await expect(configuredAutonomyTextModel(environment, reasoned.fetcher).generate({ model: 'gpt-5.6-luna', system: 's', prompt: 'p', maximumOutputTokens: 500 }))
      .rejects.toMatchObject({ code: 'AUTONOMY_MODEL_TRUNCATED', usage: { inputTokens: 800, outputTokens: 500 } });
    const filtered = fakeFetch(() => Response.json({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [], usage: { input_tokens: 800, output_tokens: 0 } }));
    await expect(configuredAutonomyTextModel(environment, filtered.fetcher).generate({ model: 'gpt-5.6-luna', system: 's', prompt: 'p', maximumOutputTokens: 500 }))
      .rejects.toMatchObject({ code: 'AUTONOMY_MODEL_EMPTY' });
  });

  it('asks for little reasoning only when told to, and stops asking a provider that refuses the field', async () => {
    const ok = () => Response.json({ candidates: [{ content: { parts: [{ text: '{"steps":[]}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    const lines: string[] = [];
    // Gemini accepts it: one request, with the field.
    const accepted = fakeFetch(ok);
    await configuredAutonomyTextModel(environment, accepted.fetcher).generate({ model: 'gemini-3.8-flash', system: '規則', prompt: '材料', maximumOutputTokens: 900, reasoning: 'low' });
    expect(accepted.calls).toHaveLength(1);
    expect(JSON.parse(accepted.calls[0]!.init.body as string).generationConfig).toEqual({ maxOutputTokens: 900, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } });
    // Gemini refuses it as malformed: asked once more without it, and from then on never sent for that model.
    let count = 0;
    const refusing = fakeFetch((_url, init) => {
      count += 1;
      return JSON.parse(init.body as string).generationConfig.thinkingConfig ? new Response('{"error":{"message":"Unknown name thinkingLevel 材料"}}', { status: 400 }) : ok();
    });
    const model = configuredAutonomyTextModel(environment, refusing.fetcher, line => lines.push(line));
    const result = await model.generate({ model: 'gemini-3.8-flash', system: '規則', prompt: '材料', maximumOutputTokens: 900, reasoning: 'low' });
    // Only the call that was answered is counted.
    expect(result).toEqual({ text: '{"steps":[]}', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(count).toBe(2);
    await model.generate({ model: 'gemini-3.8-flash', system: '規則', prompt: '材料', maximumOutputTokens: 900, reasoning: 'low' });
    expect(count).toBe(3);
    expect(refusing.calls.map(call => 'thinkingConfig' in JSON.parse(call.init.body as string).generationConfig)).toEqual([true, false, false]);
    // One fixed line, with nothing of the request or the provider's answer.
    expect(lines).toEqual(['Shannon autonomy model: google gemini-3.8-flash refused the reasoning field; sending without it from now on']);
    // A failure that is not about the shape of the request is not asked again.
    const limited = fakeFetch(() => new Response('{}', { status: 429 }));
    await expect(configuredAutonomyTextModel(environment, limited.fetcher).generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 10, reasoning: 'low' })).rejects.toThrow('AUTONOMY_MODEL_HTTP_429');
    expect(limited.calls).toHaveLength(1);
    // A request refused both with and without the field (too long, say) fails as before, and the field stays in use:
    // nothing is remembered and nothing is logged, because the field was not the cause.
    let oversized = true;
    const broken = fakeFetch(() => (oversized ? new Response('{}', { status: 400 }) : ok()));
    const brokenLines: string[] = [];
    const again = configuredAutonomyTextModel(environment, broken.fetcher, line => brokenLines.push(line));
    await expect(again.generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 10, reasoning: 'low' })).rejects.toThrow('AUTONOMY_MODEL_HTTP_400');
    expect(broken.calls).toHaveLength(2);
    oversized = false;
    await again.generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 10, reasoning: 'low' });
    expect('thinkingConfig' in JSON.parse(broken.calls[2]!.init.body as string).generationConfig).toBe(true);
    expect(brokenLines).toEqual([]);
    // 422 is the same refusal, and OpenAI falls back the same way.
    const unprocessable = fakeFetch((_url, init) => (JSON.parse(init.body as string).reasoning ? new Response('{}', { status: 422 })
      : Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"steps":[]}' }] }], usage: { input_tokens: 8, output_tokens: 2 } })));
    expect(await configuredAutonomyTextModel(environment, unprocessable.fetcher).generate({ model: 'gpt-5.6-luna', system: 's', prompt: 'p', maximumOutputTokens: 10, reasoning: 'low' }))
      .toEqual({ text: '{"steps":[]}', usage: { inputTokens: 8, outputTokens: 2 } });
    expect(unprocessable.calls).toHaveLength(2);
    // OpenAI: the field the conversation's own calls use.
    const openai = fakeFetch(() => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"steps":[]}' }] }], usage: { input_tokens: 8, output_tokens: 2 } }));
    await configuredAutonomyTextModel(environment, openai.fetcher).generate({ model: 'gpt-5.6-luna', system: '規則', prompt: '材料', maximumOutputTokens: 500, reasoning: 'low' });
    expect(JSON.parse(openai.calls[0]!.init.body as string)).toEqual({
      model: 'gpt-5.6-luna', instructions: '規則', input: '材料', text: { format: { type: 'json_object' } }, max_output_tokens: 500, reasoning: { effort: 'low' }, store: false, prompt_cache_key: autonomyPromptCacheKey('規則'),
    });
  });

  it('fails with a code that carries neither the request nor the credential', async () => {
    const refused = fakeFetch(() => new Response('{"error":{"message":"key dedicated-gemini-credential is invalid"}}', { status: 401 }));
    const model = configuredAutonomyTextModel(environment, refused.fetcher);
    const error = await model.generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 10 }).catch(caught => caught as Error);
    expect(error).toBeInstanceOf(AutonomyModelError);
    expect((error as Error).message).toBe('AUTONOMY_MODEL_HTTP_401');
    const empty = fakeFetch(() => Response.json({ candidates: [], usageMetadata: { promptTokenCount: 50 } }));
    const emptyError = await configuredAutonomyTextModel(environment, empty.fetcher)
      .generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 10 }).catch(caught => caught as AutonomyModelError);
    // The provider counted the prompt, so the usage travels with the failure and is charged.
    expect(emptyError).toMatchObject({ code: 'AUTONOMY_MODEL_EMPTY', usage: { inputTokens: 50, outputTokens: 0 } });
    await expect(configuredAutonomyTextModel({}, refused.fetcher).generate({ model: 'gemini-3.8-flash', system: 's', prompt: 'p', maximumOutputTokens: 10 }))
      .rejects.toThrow('AUTONOMY_MODEL_NOT_CONFIGURED');
    await expect(model.generate({ model: 'unlisted-model', system: 's', prompt: 'p', maximumOutputTokens: 10 })).rejects.toThrow('AUTONOMY_MODEL_NOT_CONFIGURED');
  });

  it('chooses her preference, then the default, then any model of the purpose that has a credential', () => {
    const all = () => true;
    expect(resolveAutonomyModel('prose', [], all)).toBe('gemini-3.8-flash');
    expect(resolveAutonomyModel('prose', [{ purpose: 'prose', modelId: 'gpt-5.6-sol' }], all)).toBe('gpt-5.6-sol');
    // A preference for a model the registry does not allow for that purpose is ignored.
    expect(resolveAutonomyModel('prose', [{ purpose: 'prose', modelId: 'gpt-5.6-luna' }], all)).toBe('gemini-3.8-flash');
    const geminiOnly = (id: string) => id.startsWith('gemini');
    expect(resolveAutonomyModel('planning', [], geminiOnly)).toBe('gemini-3.8-flash');
    expect(resolveAutonomyModel('research_reading', [], geminiOnly)).toBe('gemini-3.8-flash');
    const openaiOnly = (id: string) => id.startsWith('gpt');
    expect(resolveAutonomyModel('prose', [], openaiOnly)).toBe('gpt-5.6-terra');
    expect(resolveAutonomyModel('prose', [], () => false)).toBeNull();
  });
});

describe('loop bounds', () => {
  it('defaults to a few cycles a day and reads its bounds from the environment', () => {
    expect(configuredAutonomyLoop({})).toMatchObject({
      scopeKey: 'owner', cyclesPerDay: 4, cycleIntervalMilliseconds: 6 * 60 * 60_000, maximumStepsPerCycle: 6, maximumReadsPerCycle: 2,
      ownerActiveMilliseconds: 10 * 60_000, leaseMilliseconds: 600_000, budgetRequestYen: 300,
    });
    expect(configuredAutonomyLoop({}).readingSeeds.map(seed => new URL(seed.url).hostname)).toEqual(['www.aozora.gr.jp', 'ja.wikipedia.org', 'ja.wikipedia.org']);
    expect(configuredAutonomyLoop({
      SHANNON_OWNER_SCOPE_KEY: 'rai', SHANNON_AUTONOMY_CYCLES_PER_DAY: '2', SHANNON_AUTONOMY_CYCLE_MAX_STEPS: '3', SHANNON_AUTONOMY_CYCLE_MAX_READS: '1',
      SHANNON_AUTONOMY_READING_SEEDS_JSON: '[{"title":"青空文庫","url":"https://www.aozora.gr.jp/"},{"title":"だめ","url":"file:///x"}]',
    })).toMatchObject({ scopeKey: 'rai', cyclesPerDay: 2, cycleIntervalMilliseconds: 12 * 60 * 60_000, maximumStepsPerCycle: 3, maximumReadsPerCycle: 1,
      readingSeeds: [{ title: '青空文庫', url: 'https://www.aozora.gr.jp/' }] });
    // Out-of-range values fall back; the loop cannot be configured into a tight spin.
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_CYCLES_PER_DAY: '9999', SHANNON_AUTONOMY_CYCLE_MAX_STEPS: '500', SHANNON_AUTONOMY_LEASE_SECONDS: '1' }))
      .toMatchObject({ cyclesPerDay: 4, maximumStepsPerCycle: 6, leaseMilliseconds: 600_000 });
  });

  it('keeps only steps it knows, inside the bounds it is given', () => {
    const story = { id: 's1', kind: 'story' as const, title: '題', body: '本文', status: 'draft' as const, version: 1, readableVersion: null, sources: [], createdAt: 'x', updatedAt: 'x' };
    const thought = planFromThought({
      thought: '  いろいろ  やります。 ',
      pursuits: [
        { op: 'add', kind: 'goal', title: '目的を変える', why: 'x' }, { op: 'add', kind: 'work', title: '傘の話', why: '書きたいからです。' },
        { op: 'update', id: 'unknown', status: 'done' }, { op: 'update', id: 'p1', status: 'dropped' }, { op: 'update', id: 'p1', status: 'resting' }, { op: 'add', kind: 'question', title: '三つ目', why: 'x' },
      ],
      steps: [
        { action: 'read', url: 'https://example.org/1' }, { action: 'read', url: 'ftp://example.org/2' }, { action: 'read', url: 'https://example.org/3' },
        { action: 'note' }, { action: 'note' }, { action: 'notion', query: 'ウサカテ' }, { action: 'draft', idea: '傘', pursuitId: 'unknown' },
        { action: 'ready', pieceId: 's1' }, { action: 'put_away', pieceId: 's1' }, { action: 'rest' }, { action: 'draft', idea: '休んだ後' },
      ],
    }, { pursuits: [{ id: 'p1', kind: 'question', title: '問い', why: 'x', status: 'active', origin: 'self', links: [], createdAt: 'x', updatedAt: 'x' }], pieces: [story], unnotedReadingIds: [] },
    { maximumSteps: 8, maximumReads: 1, notionAvailable: false });
    expect(thought.text).toBe('いろいろ やります。');
    expect(thought.pursuits).toEqual([{ op: 'add', kind: 'work', title: '傘の話', why: '書きたいからです。' }, { op: 'update', id: 'p1', status: 'resting' }]);
    expect(thought.steps).toEqual([
      { kind: 'read', url: 'https://example.org/1' }, { kind: 'note' }, { kind: 'draft', intent: '傘' }, { kind: 'show', pieceId: 's1' }, { kind: 'put_away', pieceId: 's1' },
    ]);
    // An address she makes up loses its query string and must be short; one she was shown is kept as it is.
    const urls = planFromThought({ steps: [
      { action: 'read', url: 'https://evil.example/collect?note=%E5%82%98%E3%81%AE%E8%A9%B1&secret=1#frag' },
      { action: 'read', url: `https://evil.example/${'a'.repeat(400)}` },
      { action: 'read', url: 'https://example.org/search?q=shown' },
    ] }, { pursuits: [], pieces: [], unnotedReadingIds: [], placeUrls: ['https://example.org/search?q=shown'] }, { maximumSteps: 8, maximumReads: 5, notionAvailable: false });
    expect(urls.steps).toEqual([{ kind: 'read', url: 'https://evil.example/collect' }, { kind: 'read', url: 'https://example.org/search?q=shown' }]);
    expect(planFromThought({ steps: 'nonsense', pursuits: null }, { pursuits: [], pieces: [], unnotedReadingIds: [] }, { maximumSteps: 5, maximumReads: 2, notionAvailable: false }))
      .toEqual({ text: '', pursuits: [], steps: [] });
  });

  it('detects a note that repeats a long run of the page', () => {
    const page = '夕方の駅では、光が低く差しこみ、人の影が長くなる。帰る人と待つ人が同じ場所にいることが、懐かしさの理由だと筆者は書いている。そのうえで音についても触れている。';
    expect(sharesLongPassage(`まとめ。${page}`, page, 60)).toBe(true);
    expect(sharesLongPassage('光が低いと影が長くなり、それが懐かしさにつながるのだと思いました。待つ人がいることも大事だそうです。', page, 60)).toBe(false);
    expect(sharesLongPassage('短い', page, 60)).toBe(false);
  });
});
