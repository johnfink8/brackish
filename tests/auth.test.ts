import { describe, expect, it } from 'vitest';
import { detectTransport, isLoopbackAddress, type SocketLike } from '../src/daemon/auth.js';

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

describe('isLoopbackAddress', () => {
  it('accepts canonical IPv4 loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
  });

  it('accepts the broader 127/8 range', () => {
    expect(isLoopbackAddress('127.0.0.42')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
  });

  it('accepts IPv6 loopback', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
  });

  it('accepts IPv4-mapped IPv6 form of loopback', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects non-loopback LAN addresses', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('10.0.0.7')).toBe(false);
  });

  it('rejects public IPv4', () => {
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
  });

  it('rejects undefined and empty string', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});
