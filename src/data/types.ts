export type MenuRequest = {
  measures: string[];
  dimensions?: string[];
  filters?: { due_between?: { from: string; to: string } };
  orderBy?: { field: string; dir: "asc" | "desc" }[];
};

export type BuiltQuery = {
  sql: string;
  binds: (string | number)[];
  columns: string[];
  exemptStrings: Set<string>;
};

export type ResultTable = {
  columns: string[];
  rows: (string | number | null)[][];
};

export interface DataSource {
  run(q: BuiltQuery, req: MenuRequest): Promise<ResultTable>;
}
