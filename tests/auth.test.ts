import { describe, expect, it } from 'vitest';
import { detectTransport, type SocketLike } from '../src/daemon/auth.js';

const sock = (addr: { port: number } | Record<string, unknown> | null): SocketLike => ({
  address: () => addr,
});

describe('detectTransport', () => {
  it('treats sockets with a port in address() as TCP', () => {
    expect(detectTransport(sock({ address: '127.0.0.1', port: 11442, family: 'IPv4' }))).toBe(
      'tcp',
    );
  });

  it('treats sockets returning an empty-object address as Unix-domain (sock)', () => {
    expect(detectTransport(sock({}))).toBe('sock');
  });

  it('treats null address as Unix-domain (sock)', () => {
    expect(detectTransport(sock(null))).toBe('sock');
  });
});
