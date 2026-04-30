// Shared family contract for the /results/projections page.
// Both the projection-settled API route and ProjectionAccuracyClient import
// from here so adding or removing a family propagates to both layers at once.

export const PROJECTION_RESULTS_PAGE_FAMILIES = [
  'NHL_1P_TOTAL',
  'MLB_F5_TOTAL',
  'MLB_F5_ML',
] as const satisfies readonly string[];

export type ProjectionResultsFamily =
  (typeof PROJECTION_RESULTS_PAGE_FAMILIES)[number];

// Aliases for variant tokens that normalize to a canonical page family.
// Only add entries here — never spread these into the SQL query list.
export const PROJECTION_RESULTS_FAMILY_TOKEN_ALIASES: Record<string, string> = {
  NHL_1P_OU: 'NHL_1P_TOTAL',
  'NHL_1P_O/U': 'NHL_1P_TOTAL',
  MLB_F5_MONEYLINE: 'MLB_F5_ML',
};

export type FamilyOption = {
  id: string;
  label: string;
  families: string[];
};

export const PROJECTION_RESULTS_FAMILY_OPTIONS: FamilyOption[] = [
  { id: 'ALL', label: 'All', families: [] },
  {
    id: 'NHL_1P',
    label: 'NHL 1P O/U',
    families: ['NHL_1P_TOTAL', 'NHL_1P_OU', 'NHL_1P_O/U'],
  },
  { id: 'MLB_F5_TOTAL', label: 'MLB F5 Total', families: ['MLB_F5_TOTAL'] },
  {
    id: 'MLB_F5_MONEYLINE',
    label: 'MLB F5 Moneyline',
    families: ['MLB_F5_ML', 'MLB_F5_MONEYLINE'],
  },
];

export const PROJECTION_RESULTS_SUPPORTED_FAMILY_SET = new Set(
  PROJECTION_RESULTS_FAMILY_OPTIONS.flatMap((opt) => opt.families),
);
