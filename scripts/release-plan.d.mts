export type ReleaseBump = 'major' | 'minor' | 'patch';

export interface ReleasePlan {
  bump: ReleaseBump | 'current';
  mode: 'initial' | 'pending' | 'release' | 'resume';
  previousTag: string;
  tag: string;
  version: string;
}

export interface ReleasePlanInput {
  commits?: string[];
  current: string;
  head?: string;
  headSubject?: string;
  latestTag?: string;
  latestTagCommit?: string;
  pendingCommits?: string[];
}

export function increment(version: string, bump: ReleaseBump): string;
export function planRelease(input: ReleasePlanInput): ReleasePlan;
export function releaseBump(commits: string[]): ReleaseBump | undefined;
