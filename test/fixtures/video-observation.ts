/** Raw SDK-shape fixture, never live acceptance. */
export function timelinePage() {
  return { observation_version: 1, adapter_version: '1.0.1', project_unique_id: 'resolve-project-1',
    unique_id: 'owned-timeline-1', name: 'AI_WORK_candidate', fps: 24, duration_frames: 240, start_frame: 86400,
    total: 1, offset: 0, limit: 100, complete: true, snapshot_sha256: 'd'.repeat(64), inspection_errors: [] as string[],
    track_counts: { video: 1, audio: 0, subtitle: 0 },
    ownership: { status: 'AI_OWNED', creation_operation_id: 'prepare-1', source_timeline_unique_id: null },
    items: [{ unique_id: 'item-1', name: 'source', track_type: 'video', track_index: 1, start: 86400,
      end: 86640, duration: 240, media_unique_id: 'pool-1', source_start: 0, source_end: 239 }] };
}
