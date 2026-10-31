import { BlockList, isIP } from 'node:net';

// "Inside the house" addresses: loopback, LAN, Docker, Tailscale (CGNAT) and their IPv6 cousins.
const PRIVATE = new BlockList();
PRIVATE.addSubnet('127.0.0.0', 8);
PRIVATE.addSubnet('10.0.0.0', 8);
PRIVATE.addSubnet('172.16.0.0', 12);
PRIVATE.addSubnet('192.168.0.0', 16);
PRIVATE.addSubnet('169.254.0.0', 16);
PRIVATE.addSubnet('100.64.0.0', 10);
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const family = isIP(plain);
  if (family === 0) return false;
  return PRIVATE.check(plain, family === 6 ? 'ipv6' : 'ipv4');
}
