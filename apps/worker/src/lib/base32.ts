/**
 * RFC 4648 base32 (alphabet A–Z, 2–7), the encoding TOTP secrets are shown in.
 *
 * Implemented here rather than pulled in as a dependency: it is a dozen lines,
 * it is on the authentication path, and a wrong alphabet or a silent
 * lossy decode would break every later key derivation.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let output = "";

  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(buffer >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Decodes base32, accepting an unpadded string and ignoring case. Throws on any
 * character outside the alphabet: a permissive decoder would turn a corrupted
 * secret into a different, silently wrong key.
 */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input.replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) {
    throw new RangeError("base32 input is empty");
  }

  let buffer = 0;
  let bits = 0;
  const output: number[] = [];

  for (const character of cleaned) {
    const value = ALPHABET.indexOf(character);
    if (value === -1) {
      throw new RangeError("base32 input contains a character outside the alphabet");
    }
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  // Leftover bits that cannot form a whole byte must be zero padding, not data
  // that the caller believes was decoded.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new RangeError("base32 input has non-zero trailing bits");
  }

  return new Uint8Array(output);
}
