import { isIP } from 'node:net';

export function isPrivateOrReservedAddress(address: string): boolean {
  const raw = address.replace(/^\[|\]$/gu, '').toLowerCase();
  const family = isIP(raw);
  if (family === 4) return privateOrReservedIPv4(raw);
  if (family !== 6) return true;
  const value = new URL(`http://[${raw}]/`).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return privateOrReservedIPv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  if (value === '::' || value === '::1' || value.startsWith('::')) return true;
  const groups = value.split(':');
  const first = Number.parseInt(groups[0]!, 16);
  const second = Number.parseInt(groups[1] ?? '0', 16);
  return (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && second === 0x0db8);
}

function privateOrReservedIPv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(item => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}
