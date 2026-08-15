// Operator type — narrow copy of `src/types/operators.ts` so the MCP package
// builds with no reach into the main app's source tree. The shape is
// intentionally identical; if the webapp's OperatorDefinition gains fields,
// keep this in sync by hand.
//
// `family` is the same string union the webapp uses. We keep it loose (string)
// here so a future operator family added to the webapp doesn't break the MCP
// build — the runtime catalog is the source of truth for which families are
// actually wired up.

export type OperatorFamily =
  | 'ASIT'
  | 'TRIZ'
  | 'CONTRADICTION'
  | 'FREEFORM'
  | 'COMBINE'
  | 'EXPLORE'
  | 'ADJACENCY';

export interface OperatorDefinition {
  family: OperatorFamily;
  key: string;
  name: string;
  glyph: string;
  oneLiner: string;
  doctrine: string;
  promptFragment: string;
}
