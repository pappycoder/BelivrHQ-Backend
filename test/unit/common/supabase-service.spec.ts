jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
import { createClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../src/supabase/supabase.service';

describe('Supabase server and user authentication isolation', () => {
  const settings = {
    SUPABASE_URL: 'https://synthetic.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-admin-key',
    SUPABASE_ANON_KEY: 'synthetic-public-key',
  };
  const factory = jest.mocked(createClient);
  beforeEach(() => factory.mockReset());
  it.each([
    { ...settings, SUPABASE_URL: '' },
    { ...settings, SUPABASE_SERVICE_ROLE_KEY: '' },
  ])('refuses startup with missing server configuration', (values) => {
    expect(() => new SupabaseService(new ConfigService(values)).onModuleInit()).toThrow(
      'must be set',
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it('uses the service key only for its stateless server client', () => {
    const client = { auth: { admin: {} } };
    factory.mockReturnValue(client as never);
    const service = new SupabaseService(new ConfigService(settings));
    service.onModuleInit();
    expect(factory).toHaveBeenCalledWith(
      settings.SUPABASE_URL,
      settings.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );
    expect(service.client).toBe(client);
  });
  it('creates independent public-key clients without replacing the server client', () => {
    const server = { role: 'server' },
      user = { role: 'user' };
    factory.mockReturnValueOnce(server as never).mockReturnValueOnce(user as never);
    const service = new SupabaseService(new ConfigService(settings));
    service.onModuleInit();
    expect(service.createAuthClient()).toBe(user);
    expect(factory).toHaveBeenLastCalledWith(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    expect(service.client).toBe(server);
  });
  it('performs user-scoped Auth calls without passing the service credential or saving sessions', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"verified":true}'));
    const service = new SupabaseService(new ConfigService(settings));
    await expect(
      service.authRequest('synthetic-user-jwt', 'factors/id/verify', { code: '123456' }),
    ).resolves.toEqual({ verified: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://synthetic.supabase.co/auth/v1/factors/id/verify',
      {
        method: 'POST',
        headers: {
          apikey: settings.SUPABASE_ANON_KEY,
          Authorization: 'Bearer synthetic-user-jwt',
          'Content-Type': 'application/json',
        },
        body: '{"code":"123456"}',
        signal: expect.any(AbortSignal),
      },
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it('supports bodyless deletes and empty success responses', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const service = new SupabaseService(new ConfigService(settings));
    await expect(
      service.authRequest('synthetic-user-jwt', 'factors/id', undefined, 'DELETE'),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE', body: undefined });
  });
  it('does not expose an upstream error body or credential in authentication errors', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('synthetic-sensitive-error', { status: 403 }));
    const service = new SupabaseService(new ConfigService(settings));
    await expect(service.authRequest('synthetic-user-jwt', 'factors/id')).rejects.toThrow(
      'Authenticator request failed. Check your code and try again.',
    );
  });
});
