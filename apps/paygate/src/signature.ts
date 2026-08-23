import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * X-Paygate-Signature = hmac_sha256(raw_body, PAYGATE_SECRET), hex.
 *
 * The signature is computed over the exact bytes that go on the wire. Paygate
 * therefore serialises the payload once, signs that string, and sends that same
 * string as the request body — it never re-serialises. Signing a re-serialised
 * object is the classic way to ship a provider whose signatures fail
 * intermittently for the receiver, because key order and number formatting are
 * not guaranteed to survive a parse/stringify round trip.
 */
export function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Deliberately break a signature, for the 2% bad-signature chaos branch.
 *
 * Flips one hex digit rather than emitting garbage, so the receiver's failure
 * is a genuine HMAC mismatch of a well-formed signature — which is what a
 * misconfigured secret or a tampered body actually looks like — and not a
 * length or encoding error that a lazy verifier might reject for the wrong
 * reason.
 */
export function corrupt(signature: string): string {
  const first = signature[0];
  if (first === undefined) return 'deadbeef';
  const flipped = (parseInt(first, 16) ^ 0x1).toString(16);
  return flipped + signature.slice(1);
}

/** Constant-time verify. Exported for the README's worked example and tests. */
export function verify(rawBody: string, secret: string, signature: string): boolean {
  const expected = Buffer.from(sign(rawBody, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
