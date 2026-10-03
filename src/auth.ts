import { timingSafeEqual } from "node:crypto";

export function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function hasBearerToken(header: string | null, expected: string) {
  return sameSecret(/^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "", expected);
}
