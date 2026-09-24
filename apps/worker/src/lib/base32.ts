/**
 * Re-exported from `@securenotes/shared`, where the single implementation lives.
 *
 * The client needs the same decoder to derive the KEK from the TOTP secret, and
 * two decoders that disagree by one character would silently derive a different
 * key. Keeping one implementation removes that class of bug entirely.
 */
export { base32Decode, base32Encode } from "@securenotes/shared";
