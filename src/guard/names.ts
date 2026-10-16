export interface NameChecker {
  countMatches(texts: string[]): Promise<number[]>;
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/** In-memory twin of NAME_CHECK_SQL: same matching rules, for tests and synthetic mode. */
export class FixtureNameChecker implements NameChecker {
  private readonly fullNames: string[];
  private readonly nameWords: Set<string>;
  private readonly generic: Set<string>;

  constructor(names: string[], generic: string[]) {
    const clean = names.map((n) => n.toLowerCase()).filter((n) => n.trim() !== "");
    this.fullNames = clean.filter((n) => n.length >= 4);
    this.nameWords = new Set(clean.flatMap(words));
    this.generic = new Set(generic.map((g) => g.toLowerCase()));
  }

  async countMatches(texts: string[]): Promise<number[]> {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      const wordHits = words(lower).filter((w) => this.nameWords.has(w) && !this.generic.has(w)).length;
      const phraseHits = this.fullNames.filter((n) => lower.includes(n)).length;
      return wordHits + phraseHits;
    });
  }
}

export const NAME_CHECK_SQL = `WITH inputs AS (
  SELECT f.index AS idx, LOWER(f.value::string) AS txt FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f),
generic AS (SELECT LOWER(g.value::string) AS word FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) g),
names AS (
  SELECT LOWER(n) AS full_name FROM (
    SELECT CLIENT AS n FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT FIRST_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT MIDDLE_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT LAST_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT PREFERRED_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT LEGAL_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT_ACCOUNTING_DETAIL UNION ALL
    SELECT TRADING_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT_ACCOUNTING_DETAIL UNION ALL
    SELECT BUSINESS_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT_ACCOUNTING_DETAIL UNION ALL
    SELECT CONTACT FROM KPI_DATABASE.SECURE_VIEWS.CONTACT_MEMBER_RELATIONSHIP UNION ALL
    SELECT RELATED_CONTACT FROM KPI_DATABASE.SECURE_VIEWS.CONTACT_MEMBER_RELATIONSHIP UNION ALL
    SELECT ORGANIZATION FROM KPI_DATABASE.SECURE_VIEWS.DIMN_ORGANIZATION_MEMBER)
  WHERE n IS NOT NULL AND TRIM(n) <> ''),
name_words AS (
  SELECT DISTINCT w.value::string AS word FROM names,
    LATERAL SPLIT_TO_TABLE(REGEXP_REPLACE(full_name, '[^a-z0-9]+', ' '), ' ') w
  WHERE LENGTH(w.value) >= 2),
input_words AS (
  SELECT i.idx, w.value::string AS word FROM inputs i,
    LATERAL SPLIT_TO_TABLE(REGEXP_REPLACE(i.txt, '[^a-z0-9]+', ' '), ' ') w
  WHERE LENGTH(w.value) >= 2),
word_hits AS (
  SELECT iw.idx, COUNT(*) AS c FROM input_words iw
  JOIN name_words nw ON iw.word = nw.word
  LEFT JOIN generic g ON g.word = iw.word
  WHERE g.word IS NULL GROUP BY iw.idx),
phrase_hits AS (
  SELECT i.idx, COUNT(*) AS c FROM inputs i
  JOIN names nm ON LENGTH(nm.full_name) >= 4 AND CONTAINS(i.txt, nm.full_name)
  GROUP BY i.idx)
SELECT i.idx, COALESCE(w.c, 0) + COALESCE(p.c, 0) AS hits
FROM inputs i LEFT JOIN word_hits w ON w.idx = i.idx LEFT JOIN phrase_hits p ON p.idx = i.idx
ORDER BY i.idx`;
