jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));

import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { request } from 'node:https';
import { resolveWebhookUrl, sendWebhook } from '../../../src/webhooks/safe-webhook-request';

describe('Outbound webhook network boundary', () => {
  const dns = lookup as unknown as jest.MockedFunction<
    (host: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>
  >;
  const https = request as unknown as jest.MockedFunction<
    (
      url: URL,
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => ClientRequest
  >;
  const address = { address: '93.184.216.34', family: 4 };

  beforeEach(() => {
    jest.clearAllMocks();
    dns.mockResolvedValue([address]);
  });

  it.each([
    'not a URL',
    'http://example.org/hook',
    'https://user:password@example.org/hook',
    'https://example.org:8443/hook',
    'https://example.org/hook#fragment',
  ])('refuses unsafe URL syntax before DNS or delivery: %s', async (url) => {
    await expect(resolveWebhookUrl(url)).rejects.toThrow();
    expect(dns).not.toHaveBeenCalled();
    expect(https).not.toHaveBeenCalled();
  });

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.0.0.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.19.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2002:7f00:1::',
    '2001::1',
    '2001:100::1',
    '2001:db8::1',
  ])('refuses a private, reserved or tunnel destination: %s', async (ip) => {
    const host = ip.includes(':') ? `[${ip}]` : ip;
    await expect(resolveWebhookUrl(`https://${host}/hook`)).rejects.toThrow(
      'public internet addresses',
    );
    expect(dns).not.toHaveBeenCalled();
    expect(https).not.toHaveBeenCalled();
  });

  it.each([
    '8.8.8.8',
    '100.63.255.254',
    '100.128.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '198.20.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('accepts a public literal without a second DNS lookup: %s', async (ip) => {
    const host = ip.includes(':') ? `[${ip}]` : ip;
    const resolved = await resolveWebhookUrl(`https://${host}:443/hook`);
    expect(resolved.address.address).toBe(ip);
    expect(dns).not.toHaveBeenCalled();
  });

  it('checks every DNS answer, refusing mixed public/private responses', async () => {
    dns.mockResolvedValue([address, { address: '127.0.0.1', family: 4 }]);
    await expect(resolveWebhookUrl('https://hooks.example.org')).rejects.toThrow(
      'public internet addresses',
    );
    expect(https).not.toHaveBeenCalled();
  });

  it('refuses empty DNS responses and propagates resolution failures', async () => {
    dns.mockResolvedValueOnce([]);
    await expect(resolveWebhookUrl('https://hooks.example.org')).rejects.toThrow();
    dns.mockRejectedValueOnce(new Error('DNS unavailable'));
    await expect(resolveWebhookUrl('https://hooks.example.org')).rejects.toThrow('DNS unavailable');
  });

  function transport(statusCode: number | undefined = 202) {
    const response = Object.assign(new EventEmitter(), {
      statusCode: statusCode as number | undefined,
      destroy: jest.fn(),
    });
    const req = Object.assign(new EventEmitter(), {
      end: jest.fn(),
      destroy: jest.fn((error: Error) => {
        req.emit('error', error);
        req.emit('close');
      }),
    });
    response.destroy.mockImplementation((error: Error) => response.emit('error', error));
    https.mockImplementation((_url, _options, callback) => {
      callback(response as unknown as IncomingMessage);
      return req as unknown as ClientRequest;
    });
    return { response, req };
  }

  afterEach(() => jest.useRealTimers());

  it('pins the validated DNS address while retaining the original HTTPS hostname and payload', async () => {
    const { response, req } = transport();
    const headers = { 'x-webhook-signature': 'synthetic-signature' };
    const delivery = sendWebhook('https://hooks.example.org/path', '{"id":1}', headers);
    await Promise.resolve();
    await Promise.resolve();
    expect(dns).toHaveBeenCalledTimes(1);
    expect(dns).toHaveBeenCalledWith('hooks.example.org', { all: true, verbatim: true });
    const [url, options] = https.mock.calls[0];
    expect((url as URL).hostname).toBe('hooks.example.org');
    expect(options).toMatchObject({ method: 'POST', headers });
    const pinned = (
      options as { lookup: (host: string, opts: { all?: boolean }, cb: jest.Mock) => void }
    ).lookup;
    const callback = jest.fn();
    pinned('hooks.example.org', {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, address.address, 4);
    pinned('hooks.example.org', { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [address]);
    expect(req.end).toHaveBeenCalledWith('{"id":1}');
    response.emit('data', Buffer.from('accepted'));
    response.emit('end');
    req.emit('close');
    await expect(delivery).resolves.toEqual({ status: 202, body: 'accepted' });
  });

  it('returns redirects without following them and bounds response text', async () => {
    const { response, req } = transport(302);
    const delivery = sendWebhook('https://hooks.example.org', '{}', {});
    await Promise.resolve();
    await Promise.resolve();
    response.emit('data', Buffer.from('x'.repeat(3000)));
    response.emit('end');
    req.emit('close');
    await expect(delivery).resolves.toEqual({ status: 302, body: 'x'.repeat(2000) });
    expect(https).toHaveBeenCalledTimes(1);
  });

  it('uses 502 when the response has no status', async () => {
    const { response, req } = transport();
    response.statusCode = undefined;
    const delivery = sendWebhook('https://hooks.example.org', '{}', {});
    await Promise.resolve();
    await Promise.resolve();
    response.emit('end');
    req.emit('close');
    await expect(delivery).resolves.toEqual({ status: 502, body: '' });
  });

  it('aborts responses larger than 64 KB', async () => {
    const { response, req } = transport();
    const delivery = sendWebhook('https://hooks.example.org', '{}', {});
    const rejected = expect(delivery).rejects.toThrow('exceeds 64 KB');
    await Promise.resolve();
    await Promise.resolve();
    response.emit('data', Buffer.alloc(65536));
    expect(response.destroy).not.toHaveBeenCalled();
    response.emit('data', Buffer.from('x'));
    req.emit('close');
    await rejected;
  });

  it('rejects a stalled request after ten seconds and clears its timer on close', async () => {
    jest.useFakeTimers();
    const { req } = transport();
    const delivery = sendWebhook('https://hooks.example.org', '{}', {});
    const rejected = expect(delivery).rejects.toThrow('timed out');
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(req.destroy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propagates connection errors and clears the timeout on close', async () => {
    jest.useFakeTimers();
    const { req } = transport();
    const delivery = sendWebhook('https://hooks.example.org', '{}', {});
    const rejected = expect(delivery).rejects.toThrow('connection failed');
    await Promise.resolve();
    await Promise.resolve();
    req.emit('error', new Error('connection failed'));
    req.emit('close');
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });
});
