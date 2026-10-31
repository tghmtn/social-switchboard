import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from './net';

describe('isPrivateAddress', () => {
  it('treats home, Docker and Tailscale networks as private', () => {
    for (const ip of [
      '127.0.0.1',
      '192.168.1.2',
      '10.0.0.5',
      '172.22.0.3',
      '100.108.92.80',
      '::1',
      '::ffff:192.168.1.9',
      'fd12::1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('treats the internet as public', () => {
    for (const ip of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '2606:4700::1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
