export const OBSERVATION_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];
