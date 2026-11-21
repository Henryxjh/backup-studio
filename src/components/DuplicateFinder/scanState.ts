import type { DupPhase } from '../../../shared/dup-types';

export const SCANNING_PHASES: readonly DupPhase[] = [
  'scanning',
  'bucketing',
  'partial-hashing',
  'hashing',
  'summarizing',
  'acting',
];

export function isScanActive(scanPending: boolean, phase: DupPhase): boolean {
  return scanPending || SCANNING_PHASES.includes(phase);
}
