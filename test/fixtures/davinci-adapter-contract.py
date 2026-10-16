from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import types


adapter_path = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2]) / "state"
spec = importlib.util.spec_from_file_location("cos_davinci_adapter_contract", adapter_path)
assert spec and spec.loader
adapter = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = adapter
spec.loader.exec_module(adapter)

adapter.ROOT = root
adapter.REGISTRY_PATH = root / "ownership.json"
adapter.REVIEW_ROOT = root / "review"


class FakeItem:
    def __init__(self, unique_id: str, name: str):
        self.unique_id = unique_id
        self.name = name
        self.track_type = "video"
        self.track_index = 1
        self.start = 0
        self.end = 24
        self.duration = 24
        self.props = {"Pan": 0.0, "Opacity": 100.0}

    def get_property(self, key=None):
        return self.props.get(key) if key else dict(self.props)

    def set_properties(self, properties, raise_on_failure=False):
        mapping = {"pan": "Pan", "opacity": "Opacity"}
        results = {}
        for key, value in properties.items():
            resolved = mapping[key]
            self.props[resolved] = value
            results[resolved] = True
        return results


class FakeTimeline:
    def __init__(self, unique_id: str, name: str):
        self.unique_id = unique_id
        self.name = name
        self.fps = 24.0
        self.duration_frames = 240
        self._markers = {}
        self._items = []
        self.drop_markers = False

    def inspect(self):
        return {"name": self.name, "marker_count": len(self._markers)}

    def items(self, track_type=None):
        return list(self._items) if track_type in (None, "video") else []

    def markers(self):
        return dict(self._markers)

    def add_marker(self, frame, *, color="Blue", name="", note="", duration=1, custom_data=""):
        if not self.drop_markers:
            self._markers[frame] = {"color": color, "name": name, "note": note, "duration": duration, "customData": custom_data}


class FakeTimelineNamespace:
    def __init__(self):
        self.timelines = []
        self.current = None
        self.counter = 0

    def list(self):
        return list(self.timelines)

    def create(self, name):
        self.counter += 1
        timeline = FakeTimeline(f"TL-{self.counter}", name)
        self.timelines.append(timeline)
        self.current = timeline
        return timeline

    def set_current(self, value):
        target = value if isinstance(value, FakeTimeline) else next(t for t in self.timelines if t.name == value)
        self.current = target
        return target


class FakeClip:
    def __init__(self, unique_id: str, name: str, file_path: str):
        self.unique_id = unique_id
        self.name = name
        self.file_path = file_path
        self.raw = self


class FakeFolder:
    def __init__(self):
        self.name = "Imported"
        self.clips = []


class FakeMedia:
    def __init__(self, project):
        self.project = project
        self.folder = FakeFolder()
        self.counter = 0

    def ensure_folder_path(self, _path):
        return self.folder

    def walk(self):
        return [self.folder]

    def find_or_import(self, source, *, folder=None):
        for clip in self.folder.clips:
            if pathlib.Path(clip.file_path).resolve() == pathlib.Path(source).resolve():
                return clip
        self.counter += 1
        clip = FakeClip(f"MEDIA-{self.counter}", pathlib.Path(source).name, str(pathlib.Path(source).resolve()))
        self.folder.clips.append(clip)
        return clip

    def append_to_timeline(self, payload):
        timeline = self.project.timeline.current
        out = []
        for entry in payload:
            clip = entry["mediaPoolItem"]
            item = FakeItem(f"ITEM-{len(timeline._items) + 1}", clip.name)
            timeline._items.append(item)
            out.append(item)
        return out


class FakeProject:
    def __init__(self):
        self.unique_id = "PROJECT-1"
        self.name = "Untitled Project 2"
        self.timeline = FakeTimelineNamespace()
        self.media = FakeMedia(self)
        self.save_count = 0

    def save(self):
        self.save_count += 1

    def export_current_frame_as_still(self, target):
        pathlib.Path(target).write_bytes(b"png")


class FakeProjectNamespace:
    def __init__(self, project):
        self.current = project


class FakeApp:
    version = "20.2.3"
    product = "DaVinci Resolve Studio"


class FakeJob:
    def __init__(self, job_id, output_path):
        self.id = job_id
        self.output_path = output_path


class FakeRender:
    def __init__(self):
        self.jobs = []
        self.output = None

    def queue(self):
        return list(self.jobs)

    def submit(self, *, target_dir, custom_name, preset=None, format=None, codec=None, start=True):
        self.output = str(pathlib.Path(target_dir) / f"{custom_name}.mp4")
        job = {"JobId": "JOB-1", "OutputFilename": self.output}
        self.jobs.append(job)
        return FakeJob("JOB-1", self.output)

    def status(self, job_id):
        return {"job_id": job_id, "status": "Complete", "output_path": self.output}


class FakeResolve:
    def __init__(self, project):
        self.project = FakeProjectNamespace(project)
        self.app = FakeApp()
        self.render = FakeRender()


project = FakeProject()
resolve = FakeResolve(project)
adapter._connect = lambda: resolve

dvr_module = types.ModuleType("dvr")
schema_module = types.SimpleNamespace(
    normalize_clip_properties=lambda properties: {
        {"pan": "Pan", "opacity": "Opacity"}[key]: value for key, value in properties.items()
    }
)
dvr_module.schema = schema_module
sys.modules["dvr"] = dvr_module

report = {}

prepared = adapter._prepare({"operation_id": "op-create", "name": "contract"})
timeline_id = prepared["after"]["unique_id"]
report["prepare_verified"] = prepared["requested"] and prepared["executed"] and prepared["verified"]
report["prepare_saved"] = project.save_count == 1
again = adapter._prepare({"operation_id": "op-create", "name": "contract"})
report["prepare_idempotent"] = (not again["executed"]) and again["verified"] and len(project.timeline.list()) == 1

fake_primary = FakeTimeline("PRIMARY-1", "AI_WORK_name_only")
project.timeline.timelines.append(fake_primary)
try:
    adapter._owned_timeline(project, fake_primary.unique_id)
    report["primary_rejected"] = False
except adapter.AdapterError as exc:
    report["primary_rejected"] = exc.code == "TIMELINE_NOT_AI_OWNED"

owned = next(t for t in project.timeline.list() if t.unique_id == timeline_id)
project.timeline.timelines.remove(owned)
try:
    adapter._owned_timeline(project, timeline_id)
    report["stale_rejected"] = False
except adapter.AdapterError as exc:
    report["stale_rejected"] = exc.code == "STALE_TIMELINE_ID"
project.timeline.timelines.insert(0, owned)
project.timeline.set_current(owned)

media_file = root.parent / "source.mov"
media_file.write_bytes(b"fixture")
imported = adapter._import_media({"paths": [str(media_file.resolve())]})
report["import_verified"] = imported["executed"] and imported["verified"] and bool(imported["after"][0]["unique_id"])
report["import_saved"] = project.save_count == 2
media_id = imported["after"][0]["unique_id"]

rough = adapter._assemble({"timeline_unique_id": timeline_id, "segments": [{"media_unique_id": media_id, "start_frame": 0, "end_frame": 24}]})
report["rough_cut_verified"] = rough["executed"] and rough["verified"] and rough["after"][-1]["name"] == media_file.name
report["rough_cut_saved"] = project.save_count == 3

marker = adapter._set_marker({"timeline_unique_id": timeline_id, "operation_id": "op-marker", "frame": 12, "name": "Contract"})
report["marker_verified"] = marker["executed"] and marker["verified"]
report["marker_saved"] = project.save_count == 4
owned.drop_markers = True
ambiguous = adapter._set_marker({"timeline_unique_id": timeline_id, "operation_id": "op-marker-ambiguous", "frame": 18})
report["ambiguous_no_replay"] = ambiguous["executed"] and not ambiguous["verified"] and ambiguous["error"]["code"] == "AMBIGUOUS_MUTATION"
report["ambiguous_not_saved"] = project.save_count == 4
owned.drop_markers = False

item_id = owned._items[0].unique_id
properties = adapter._set_clip_properties({"timeline_unique_id": timeline_id, "item_unique_id": item_id, "properties": {"pan": 25.0, "opacity": 80.0}})
report["properties_verified"] = properties["executed"] and properties["verified"] and properties["after"] == {"Pan": 25.0, "Opacity": 80.0}
report["properties_saved"] = project.save_count == 5

render = adapter._render_review({"timeline_unique_id": timeline_id, "operation_id": "op-render", "start": True})
report["render_job_verified"] = render["executed"] and render["verified"] and render["after"]["job_id"] == "JOB-1"
pathlib.Path(resolve.render.output).parent.mkdir(parents=True, exist_ok=True)
pathlib.Path(resolve.render.output).write_bytes(b"render")
status = adapter._render_status({"job_id": "JOB-1"})
report["render_artifact_verified"] = status["status"] == "Complete" and status["verified"] and status["artifact_exists"]
try:
    adapter._render_status({"job_id": "FOREIGN-JOB"})
    report["foreign_render_rejected"] = False
except adapter.AdapterError as exc:
    report["foreign_render_rejected"] = exc.code == "RENDER_JOB_NOT_AI_OWNED"

project.export_current_frame_as_still = None
capture = adapter._capture_frame({"timeline_unique_id": timeline_id, "operation_id": "op-frame-missing"})
report["missing_api_clear"] = (not capture["verified"]) and capture["error"]["code"] == "FRAME_CAPTURE_FAILED"

# Read-only evidence acquisition must preserve source identity, pagination and failures.
owned.start_frame = 86400
owned.track_count = lambda kind: 1 if kind == "video" else 0
owned._items[0].source_range = (12, 35)
owned._items[0].clip = project.media.folder.clips[0]
project.media.folder.clips[0].get_property = lambda: {"Frames": "480", "FPS": "24", "Resolution": "1920x1080"}
observed = adapter._inspect({"selector": "timeline", "timeline_unique_id": timeline_id, "limit": 1})
report["inspection_source_ranges"] = observed["items"][0]["source_start"] == 12 and observed["items"][0]["source_end"] == 35 and observed["items"][0]["media_unique_id"] == media_id
report["inspection_owner_receipt"] = observed["project_unique_id"] == project.unique_id and observed["ownership"]["status"] == "AI_OWNED" and observed["ownership"]["creation_operation_id"] == "op-create"
report["inspection_page_receipt"] = observed["total"] == 1 and observed["offset"] == 0 and observed["complete"] and len(observed["snapshot_sha256"]) == 64
media_observed = adapter._inspect({"selector": "media"})
report["inspection_media_properties"] = media_observed["items"][0]["properties"]["Frames"] == "480"
original_items = owned.items
owned.items = lambda kind: (_ for _ in ()).throw(RuntimeError("track unavailable")) if kind == "audio" else original_items(kind)
lost_track = adapter._inspect({"selector": "timeline", "timeline_unique_id": timeline_id})
report["inspection_track_failure_explicit"] = not lost_track["complete"] and "TRACK_UNAVAILABLE:audio" in lost_track["inspection_errors"]
owned.items = original_items

# The optional first-acceptance guard must reject before any timeline selection/append.
for label, changes in (("guard_wrong_project", {"expected_project_unique_id": "WRONG"}),
                       ("guard_stale_snapshot", {"expected_snapshot_sha256": "0" * 64})):
    try:
        adapter._assemble({"timeline_unique_id": timeline_id, "segments": [{"media_unique_id": media_id}],
                           "expected_project_unique_id": project.unique_id,
                           "expected_snapshot_sha256": observed["snapshot_sha256"], "guard_version": 1, **changes})
        report[label] = False
    except adapter.AdapterError as exc:
        report[label] = exc.code in ("TARGET_PROJECT_MISMATCH", "PRE_STATE_CHANGED")
try:
    adapter._assemble({"timeline_unique_id": timeline_id, "segments": [{"media_unique_id": media_id}],
                       "expected_project_unique_id": project.unique_id,
                       "expected_snapshot_sha256": observed["snapshot_sha256"], "guard_version": 1})
    report["guard_nonempty_rejected"] = False
except adapter.AdapterError as exc:
    report["guard_nonempty_rejected"] = exc.code == "TARGET_NOT_EMPTY"

# A duplicate display name must never select another timeline for append.
original_items = list(owned._items)
original_duration = owned.duration_frames
original_project_name = project.name
owned._items = []
owned.duration_frames = 0
project.name = "COS_S75_ACCEPTANCE_CONTRACT"
shadow = FakeTimeline("SHADOW", owned.name)
project.timeline.timelines.insert(0, shadow)
fresh = adapter._timeline_observation(project, owned, 0, 100)
try:
    adapter._assemble({"timeline_unique_id": timeline_id, "segments": [{"media_unique_id": media_id, "start_frame": 0, "end_frame": 23}],
                       "guard_version": 1, "expected_project_unique_id": project.unique_id,
                       "expected_snapshot_sha256": fresh["snapshot_sha256"]})
    report["guard_duplicate_name_exact_target"] = len(owned._items) == 1 and not shadow._items
except adapter.AdapterError:
    report["guard_duplicate_name_exact_target"] = not shadow._items
owned._items = original_items
owned.duration_frames = original_duration
project.name = original_project_name
project.timeline.timelines.remove(shadow)

# Guard-only fallback policy checks: no append, no live backend.
saved_name = owned.name
owned._items = []
owned.duration_frames = 0
owned.name = "AI_WORK_Kosmosyn_S7.5_Acceptance_contract"
project.name = "Untitled Project 2"
fresh = adapter._timeline_observation(project, owned, 0, 100)
args = {"guard_version": 2, "expected_project_unique_id": project.unique_id,
        "expected_snapshot_sha256": fresh["snapshot_sha256"]}
try:
    adapter._guard_assembly(resolve, project, owned, args)
    report["guard_acceptance_timeline_fallback"] = True
except adapter.AdapterError:
    report["guard_acceptance_timeline_fallback"] = False
owned.name = "AI_WORK_production"
args["expected_snapshot_sha256"] = adapter._timeline_observation(project, owned, 0, 100)["snapshot_sha256"]
try:
    adapter._guard_assembly(resolve, project, owned, args)
    report["guard_production_timeline_rejected"] = False
except adapter.AdapterError as exc:
    report["guard_production_timeline_rejected"] = exc.code == "CAPABILITY_UNAVAILABLE"
owned.name = saved_name
owned._items = original_items
owned.duration_frames = original_duration
project.name = original_project_name

adapter._connect = lambda: (_ for _ in ()).throw(RuntimeError("Resolve is not running"))
adapter._sdk_info = lambda: {"script_api": "fixture", "script_lib": None, "pythonpath": None, "sdk_present": True}
health = adapter._health({})
report["backend_absent_classified"] = health["code"] == "RESOLVE_NOT_RUNNING" and not health["ready"]

# Optional compiler -> real adapter -> observation round trips. The native double
# uses the exclusive ends measured through Resolve 21.1.1 GetEnd/GetDuration;
# it never imports dvr, contacts Resolve, or touches production ownership custody.
if len(sys.argv) > 3:
    report["frame_contract"] = []
    for index, case in enumerate(json.loads(pathlib.Path(sys.argv[3]).read_text(encoding="utf-8"))):
        adapter.ROOT = root / f"frame-{index}"
        adapter.REGISTRY_PATH = adapter.ROOT / "ownership.json"
        project = FakeProject()
        project.name = "COS_S75_ACCEPTANCE_FRAME_CONTRACT"
        resolve = FakeResolve(project)
        adapter._connect = lambda: resolve
        adapter._prepare({"operation_id": "prepare-1", "name": "frame-contract"})
        timeline = project.timeline.current
        timeline.start_frame = case["startFrame"]
        timeline.duration_frames = 0
        timeline.track_count = lambda kind: 1 if kind == "video" else 0
        clip = FakeClip("pool-1", "source", "fixture.mov")
        project.media.folder.clips.append(clip)
        dispatched = []

        def append_exclusive(payload):
            for entry in payload:
                dispatched.append({key: value for key, value in entry.items() if key != "mediaPoolItem"})
                item = FakeItem(f"frame-item-{len(timeline._items)}", clip.name)
                item.start = entry["recordFrame"]
                item.duration = entry["endFrame"] - entry["startFrame"]
                item.end = item.start + item.duration
                item.source_range = (entry["startFrame"], entry["endFrame"])
                item.clip = clip
                timeline._items.append(item)
            timeline.duration_frames = max(item.end for item in timeline._items) - timeline.start_frame
            return list(timeline._items)

        project.media.append_to_timeline = append_exclusive
        before = adapter._timeline_observation(project, timeline, 0, 100)
        receipt = adapter._assemble({**case["arguments"], "guard_version": 2,
                                    "expected_project_unique_id": project.unique_id,
                                    "expected_snapshot_sha256": before["snapshot_sha256"]})
        report["frame_contract"].append({"payload": dispatched, "receipt": receipt,
                                        "observation": adapter._timeline_observation(project, timeline, 0, 100)})

print(json.dumps(report, sort_keys=True))
