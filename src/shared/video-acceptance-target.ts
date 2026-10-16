/** First operator acceptance isolation labels, shared with the generated adapter.
 * A label only selects the isolation route; exact identity, complete empty state,
 * fresh adapter ownership and reviewed snapshot/authority remain mandatory. */
export const VIDEO_ACCEPTANCE_PROJECT_PREFIX = 'COS_S75_ACCEPTANCE';
export const VIDEO_ACCEPTANCE_TIMELINE_PREFIX = 'AI_WORK_Kosmosyn_S7.5_Acceptance_';
export const VIDEO_ACCEPTANCE_GUARD_VERSION = 2;
export function acceptanceTargetIsolation(projectName: string, timelineName: string): boolean {
  return projectName.startsWith(VIDEO_ACCEPTANCE_PROJECT_PREFIX) || timelineName.startsWith(VIDEO_ACCEPTANCE_TIMELINE_PREFIX);
}
