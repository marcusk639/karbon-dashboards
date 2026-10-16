export type PatternKind = "email" | "phone" | "ssn" | "ein" | "opaque_id" | "url";

const PATTERNS: [Exclude<PatternKind, "url">, RegExp][] = [
  ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ["phone", /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/],
  ["ein", /\b\d{2}-\d{7}\b/],
  ["opaque_id", /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{10,}\b/],
];
const URL_PATTERN = /(https?:\/\/|www\.)/i;

export function findPatterns(text: string, opts: { urls?: boolean } = {}): PatternKind[] {
  const found: PatternKind[] = PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (opts.urls && URL_PATTERN.test(text)) found.push("url");
  return found;
}
