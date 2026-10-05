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

adapter._connect = lambda: (_ for _ in ()).throw(RuntimeError("Resolve is not running"))
adapter._sdk_info = lambda: {"script_api": "fixture", "script_lib": None, "pythonpath": None, "sdk_present": True}
health = adapter._health({})
report["backend_absent_classified"] = health["code"] == "RESOLVE_NOT_RUNNING" and not health["ready"]

print(json.dumps(report, sort_keys=True))
