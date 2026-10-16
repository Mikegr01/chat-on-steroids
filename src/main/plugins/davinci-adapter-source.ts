/**
 * Deterministic source for the private CoS-owned Resolve adapter.
 * This intentionally does not expose dvr's upstream MCP server.
 */
import { VIDEO_ACCEPTANCE_PROJECT_PREFIX, VIDEO_ACCEPTANCE_TIMELINE_PREFIX, VIDEO_ACCEPTANCE_GUARD_VERSION } from '../../shared/video-acceptance-target.js';

export const DAVINCI_ADAPTER_SOURCE = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import atexit
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

ADAPTER_VERSION = "1.0.4"
OWNERSHIP_VERSION = 1
AI_BIN = "AI_WORK/Imported"
ROOT = Path.cwd() / "davinci"
REGISTRY_PATH = ROOT / "ownership.json"
REVIEW_ROOT = ROOT / "review"

PUBLIC_TOOLS = (
    "resolve_health",
    "resolve_inspect",
    "resolve_prepare_ai_timeline",
    "resolve_import_media",
    "resolve_assemble_rough_cut",
    "resolve_set_marker",
    "resolve_set_basic_clip_properties",
    "resolve_render_review",
    "resolve_render_status",
    "resolve_capture_frame",
)

HEALTH_CODES = {
    "READY",
    "RESOLVE_NOT_RUNNING",
    "SCRIPTING_API_MISSING",
    "PYTHON_INCOMPATIBLE",
    "CONNECTION_FAILED",
    "VERSION_OR_CAPABILITY_UNSUPPORTED",
}


class AdapterError(Exception):
    def __init__(self, code: str, message: str, *, state: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.state = state or {}


def _schema(properties: dict[str, Any] | None = None, *, required: list[str] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "object", "properties": properties or {}, "additionalProperties": False}
    if required:
        out["required"] = required
    return out


def _mutation(before: Any, after: Any, *, executed: bool, verified: bool, warnings: list[str] | None = None, error: Any = None) -> dict[str, Any]:
    return {
        "requested": True,
        "executed": bool(executed),
        "verified": bool(verified),
        "before": before,
        "after": after,
        "warnings": warnings or [],
        "error": error,
    }


def _save_verified_project(project: Any, before: Any, after: Any, label: str) -> dict[str, Any] | None:
    try:
        project.save()
    except Exception as exc:
        return _ambiguous(before, after, f"{label} was verified in Resolve but project save failed: {exc}")
    return None


def _ambiguous(before: Any, after: Any, message: str) -> dict[str, Any]:
    return _mutation(
        before,
        after,
        executed=True,
        verified=False,
        warnings=["AMBIGUOUS_MUTATION: execution may have completed; inspect state before any retry."],
        error={"code": "AMBIGUOUS_MUTATION", "message": message},
    )


def _load_registry() -> dict[str, Any]:
    if not REGISTRY_PATH.exists():
        return {"version": OWNERSHIP_VERSION, "timelines": {}, "operations": {}, "media": {}, "renders": {}}
    try:
        data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        raise AdapterError("OWNERSHIP_REGISTRY_INVALID", f"Ownership registry could not be read: {exc}") from exc
    if data.get("version") != OWNERSHIP_VERSION:
        raise AdapterError("OWNERSHIP_REGISTRY_VERSION_UNSUPPORTED", "Ownership registry version is unsupported.")
    for key in ("timelines", "operations", "media", "renders"):
        data.setdefault(key, {})
    return data


def _save_registry(data: dict[str, Any]) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    temp = REGISTRY_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temp, REGISTRY_PATH)


def _sdk_info() -> dict[str, Any]:
    candidates: list[Path] = []
    explicit = os.environ.get("RESOLVE_SCRIPT_API")
    if explicit:
        candidates.append(Path(explicit))
    if sys.platform.startswith("win"):
        pd = os.environ.get("PROGRAMDATA")
        if pd:
            candidates.append(Path(pd) / "Blackmagic Design" / "DaVinci Resolve" / "Support" / "Developer" / "Scripting")
    elif sys.platform == "darwin":
        candidates.append(Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"))
    else:
        candidates.append(Path("/opt/resolve/Developer/Scripting"))
    available = [str(p) for p in candidates if (p / "Modules" / "DaVinciResolveScript.py").is_file()]
    return {
        "script_api": available[0] if available else explicit,
        "script_lib": os.environ.get("RESOLVE_SCRIPT_LIB"),
        "pythonpath": os.environ.get("PYTHONPATH"),
        "sdk_present": bool(available or explicit),
    }


_RESOLVE: Any = None
_RESOLVE_ERROR: tuple[float, BaseException] | None = None


def _connect() -> Any:
    global _RESOLVE, _RESOLVE_ERROR
    if _RESOLVE is not None:
        try:
            _ = _RESOLVE.app.version
            return _RESOLVE
        except Exception:
            _RESOLVE = None
    if _RESOLVE_ERROR is not None and time.monotonic() - _RESOLVE_ERROR[0] < 5.0:
        raise _RESOLVE_ERROR[1]
    try:
        from dvr import Resolve
        _RESOLVE = Resolve(auto_launch=False, timeout=5.0, discover_remote=False)
        _RESOLVE_ERROR = None
        return _RESOLVE
    except BaseException as exc:
        _RESOLVE_ERROR = (time.monotonic(), exc)
        raise


def _close() -> None:
    global _RESOLVE
    if _RESOLVE is not None:
        try:
            _RESOLVE.close(cancel_pending_renders=False)
        except Exception:
            pass
    _RESOLVE = None


atexit.register(_close)


def _version_supported(version: str) -> bool:
    try:
        return int(version.split(".", 1)[0]) >= 18
    except Exception:
        return False


def _classify_connection_error(exc: BaseException, sdk: dict[str, Any]) -> str:
    text = f"{type(exc).__name__}: {exc}".lower()
    if "not running" in text or "no local resolve responded" in text or "external scripting" in text or "could not connect" in text or "timed out" in text:
        return "RESOLVE_NOT_RUNNING"
    if not sdk.get("sdk_present") or "davinciresolvescript" in text and ("no module" in text or "not found" in text):
        return "SCRIPTING_API_MISSING"
    if "dll" in text or "access violation" in text or "incompatible" in text:
        return "PYTHON_INCOMPATIBLE"
    return "CONNECTION_FAILED"


def _identity(obj: Any) -> str:
    value = getattr(obj, "unique_id", "")
    if callable(value):
        value = value()
    return str(value or "")


def _current_project(resolve: Any) -> Any:
    project = resolve.project.current
    if project is None:
        raise AdapterError("NO_CURRENT_PROJECT", "No Resolve project is currently loaded.")
    if not _identity(project):
        raise AdapterError("PROJECT_ID_UNAVAILABLE", "The current project does not expose a stable unique ID.")
    return project


def _project_summary(project: Any) -> dict[str, Any]:
    current = project.timeline.current
    return {
        "name": project.name,
        "unique_id": _identity(project),
        "timeline_count": len(project.timeline.list()),
        "current_timeline": None if current is None else {"name": current.name, "unique_id": _identity(current)},
    }


def _timeline_summary(timeline: Any) -> dict[str, Any]:
    return {
        "name": timeline.name,
        "unique_id": _identity(timeline),
        "fps": getattr(timeline, "fps", None),
        "duration_frames": getattr(timeline, "duration_frames", None),
    }


def _timeline_by_id(project: Any, timeline_id: str) -> Any | None:
    for timeline in project.timeline.list():
        if _identity(timeline) == timeline_id:
            return timeline
    return None


def _owned_timeline(project: Any, timeline_id: str) -> tuple[Any, dict[str, Any]]:
    registry = _load_registry()
    record = registry["timelines"].get(timeline_id)
    if not record:
        raise AdapterError("TIMELINE_NOT_AI_OWNED", "Timeline is not present in the adapter ownership registry.", state={"timeline_unique_id": timeline_id})
    if record.get("project_unique_id") != _identity(project):
        raise AdapterError("TIMELINE_PROJECT_MISMATCH", "Owned timeline record belongs to a different Resolve project.")
    timeline = _timeline_by_id(project, timeline_id)
    if timeline is None or _identity(timeline) != timeline_id:
        raise AdapterError("STALE_TIMELINE_ID", "The recorded AI timeline unique ID is not currently observable.")
    return timeline, record


def _sanitize(value: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("._-")
    return (clean or "timeline")[:48]


def _items(timeline: Any) -> list[Any]:
    out: list[Any] = []
    for track_type in ("video", "audio"):
        try:
            out.extend(list(timeline.items(track_type)))
        except Exception:
            pass
    return out


def _item_snapshot(timeline: Any) -> list[dict[str, Any]]:
    return [
        {
            "unique_id": _identity(item),
            "name": item.name,
            "track_type": item.track_type,
            "track_index": item.track_index,
            "start": item.start,
            "end": item.end,
            "duration": item.duration,
        }
        for item in _items(timeline)
    ]


def _find_media(project: Any, media_id: str) -> Any | None:
    for folder in project.media.walk():
        for clip in folder.clips:
            if _identity(clip) == media_id:
                return clip
    return None


def _timeline_observation(project: Any, timeline: Any, offset: int, limit: int) -> dict[str, Any]:
    # Evidence acquisition only. Never set current timeline, save, seek, or manufacture a lost track.
    errors: list[str] = []
    counts: dict[str, Any] = {}
    rows: list[dict[str, Any]] = []
    for kind in ("video", "audio", "subtitle"):
        try:
            counts[kind] = timeline.track_count(kind)
        except Exception:
            counts[kind] = None
            errors.append(f"TRACK_COUNT_UNAVAILABLE:{kind}")
        if kind == "subtitle":
            if counts[kind]:
                errors.append("SUBTITLE_INSPECTION_UNSUPPORTED")
            continue
        try:
            for item in timeline.items(kind):
                if len(rows) >= 500:
                    raise AdapterError("TIMELINE_OBSERVATION_LIMIT", "Timeline has more than 500 observable items.")
                source_start = source_end = media_id = None
                try:
                    source_start, source_end = item.source_range
                    media_id = _identity(item.clip) or None
                except Exception:
                    errors.append(f"SOURCE_RANGE_UNAVAILABLE:{kind}")
                rows.append({"unique_id": _identity(item), "name": str(item.name)[:4096],
                             "track_type": item.track_type, "track_index": item.track_index,
                             "start": item.start, "end": item.end, "duration": item.duration,
                             "source_start": source_start, "source_end": source_end, "media_unique_id": media_id})
        except AdapterError:
            raise
        except Exception:
            errors.append(f"TRACK_UNAVAILABLE:{kind}")
    ownership = {"status": "UNOWNED", "creation_operation_id": None, "source_timeline_unique_id": None}
    try:
        record = _load_registry()["timelines"].get(_identity(timeline))
        if record and record.get("project_unique_id") == _identity(project) and record.get("creation_operation_id"):
            ownership = {"status": "AI_OWNED", "creation_operation_id": record["creation_operation_id"],
                         "source_timeline_unique_id": (record.get("source_timeline") or {}).get("unique_id")}
        elif record:
            ownership["status"] = "UNVERIFIED"
    except Exception:
        ownership["status"] = "UNVERIFIED"
        errors.append("OWNERSHIP_UNAVAILABLE")
    try:
        start_frame = timeline.start_frame
    except Exception:
        start_frame = None
        errors.append("TIMELINE_START_UNAVAILABLE")
    snapshot = {**_timeline_summary(timeline), "observation_version": 1, "adapter_version": ADAPTER_VERSION,
                "project_unique_id": _identity(project), "project_name": str(project.name),
                "rough_cut_guard_version": ${VIDEO_ACCEPTANCE_GUARD_VERSION}, "source_end": "inclusive", "start_frame": start_frame,
                "track_counts": counts, "ownership": ownership, "total": len(rows),
                "complete": not errors, "inspection_errors": sorted(set(errors))[:100], "items": rows}
    digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {**snapshot, "snapshot_sha256": digest, "offset": offset, "limit": limit,
            "items": rows[offset:offset + limit], "state": {"track_counts": counts}}


def _media_observation(clip: Any, folder: Any) -> dict[str, Any]:
    # Preserve only documented scalar properties. No waveform/beat/vision inference.
    properties: dict[str, Any] = {}
    status = "UNAVAILABLE"
    try:
        raw = clip.get_property() or {}
        keys = ("Frames", "FPS", "Resolution", "Video Codec", "Audio Codec", "Audio Ch", "Type", "Duration")
        properties = {key: raw[key] for key in keys if key in raw and isinstance(raw[key], (str, int, float, bool))}
        properties = {key: value[:4096] if isinstance(value, str) else value for key, value in properties.items()}
        status = "KNOWN"
    except Exception:
        pass
    return {"name": str(clip.name)[:4096], "unique_id": _identity(clip), "path": clip.file_path,
            "folder": str(folder.name)[:4096], "properties": properties, "properties_status": status}


def _health(_args: dict[str, Any]) -> dict[str, Any]:
    sdk = _sdk_info()
    base = {
        "adapter_version": ADAPTER_VERSION,
        "connection_status": "degraded",
        "code": "CONNECTION_FAILED",
        "ready": False,
        "resolve": None,
        "edition": None,
        "scripting": {**sdk, "python": sys.version.split()[0]},
        "project": None,
        "timeline": None,
    }
    try:
        resolve = _connect()
        version = str(resolve.app.version or "")
        product = str(resolve.app.product or "")
        if not _version_supported(version):
            return {**base, "code": "VERSION_OR_CAPABILITY_UNSUPPORTED", "resolve": {"product": product, "version": version}, "error": "Resolve version is below the supported scripting baseline."}
        project = resolve.project.current
        timeline = project.timeline.current if project is not None else None
        return {
            **base,
            "connection_status": "ready",
            "code": "READY",
            "ready": True,
            "resolve": {"product": product, "version": version},
            "edition": "Studio" if "studio" in product.lower() else "Free/Unknown",
            "project": None if project is None else {"name": project.name, "unique_id": _identity(project)},
            "timeline": None if timeline is None else {"name": timeline.name, "unique_id": _identity(timeline)},
        }
    except BaseException as exc:
        code = _classify_connection_error(exc, sdk)
        if code not in HEALTH_CODES:
            code = "CONNECTION_FAILED"
        return {**base, "code": code, "error": f"{type(exc).__name__}: {exc}"}


def _inspect(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    project = _current_project(resolve)
    selector = str(args.get("selector", "project"))
    offset = max(0, int(args.get("offset", 0)))
    limit = min(100, max(1, int(args.get("limit", 50))))
    if selector == "project":
        return _project_summary(project)
    if selector == "timelines":
        timelines = project.timeline.list()
        return {"total": len(timelines), "offset": offset, "limit": limit, "items": [_timeline_summary(t) for t in timelines[offset:offset + limit]]}
    if selector == "timeline":
        timeline_id = args.get("timeline_unique_id")
        timeline = _timeline_by_id(project, str(timeline_id)) if timeline_id else project.timeline.current
        if timeline is None:
            raise AdapterError("TIMELINE_NOT_FOUND", "Requested timeline is not currently observable.")
        return _timeline_observation(project, timeline, offset, limit)
    if selector == "media":
        rows: list[tuple[Any, Any]] = []
        for folder in project.media.walk():
            for clip in folder.clips:
                if len(rows) >= 10000:
                    raise AdapterError("MEDIA_OBSERVATION_LIMIT", "Media pool exceeds the bounded observation scope.")
                rows.append((clip, folder))
        return {"project_unique_id": _identity(project), "adapter_version": ADAPTER_VERSION,
                "total": len(rows), "offset": offset, "limit": limit,
                "items": [_media_observation(clip, folder) for clip, folder in rows[offset:offset + limit]]}
    raise AdapterError("INVALID_SELECTOR", "selector must be project, timelines, timeline, or media.")


def _prepare(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    project = _current_project(resolve)
    operation_id = str(args["operation_id"])
    registry = _load_registry()
    prior = registry["operations"].get(operation_id)
    if prior:
        timeline_id = str(prior.get("timeline_unique_id", ""))
        timeline, _ = _owned_timeline(project, timeline_id)
        snapshot = _timeline_summary(timeline)
        return _mutation(snapshot, snapshot, executed=False, verified=True, warnings=["Operation ID already completed; no duplicate timeline was created."])
    before = _project_summary(project)
    suffix = _sanitize(operation_id)[:12]
    name = f"AI_WORK_{_sanitize(str(args.get('name') or 'timeline'))}_{suffix}"
    try:
        source_id = args.get("source_timeline_unique_id")
        if source_id:
            source = _timeline_by_id(project, str(source_id))
            if source is None:
                raise AdapterError("SOURCE_TIMELINE_NOT_FOUND", "Source timeline unique ID was not found.")
            timeline = source.duplicate(name)
            source_record = {"unique_id": _identity(source), "name": source.name}
        else:
            timeline = project.timeline.create(name)
            source_record = None
        project.timeline.set_current(timeline.name)
    except AdapterError:
        raise
    except Exception as exc:
        return _mutation(before, _project_summary(project), executed=False, verified=False, error={"code": "TIMELINE_CREATE_FAILED", "message": str(exc)})
    timeline_id = _identity(timeline)
    if not timeline_id:
        return _ambiguous(before, _project_summary(project), "Resolve created a timeline but did not expose its unique ID.")
    record = {
        "project_unique_id": _identity(project),
        "timeline_unique_id": timeline_id,
        "timeline_name": timeline.name,
        "creation_operation_id": operation_id,
        "source_timeline": source_record,
        "created_at": time.time(),
        "adapter_version": ADAPTER_VERSION,
    }
    registry["timelines"][timeline_id] = record
    registry["operations"][operation_id] = {"kind": "prepare_timeline", "timeline_unique_id": timeline_id}
    try:
        _save_registry(registry)
    except Exception as exc:
        return _ambiguous(before, _timeline_summary(timeline), f"Timeline exists but ownership persistence failed: {exc}")
    observed = _timeline_by_id(project, timeline_id)
    after = None if observed is None else _timeline_summary(observed)
    verified = observed is not None and _identity(observed) == timeline_id and _load_registry()["timelines"].get(timeline_id, {}).get("creation_operation_id") == operation_id
    if not verified:
        return _ambiguous(before, after, "Timeline creation could not be verified against the durable ownership registry.")
    save_error = _save_verified_project(project, before, after, "Timeline creation")
    if save_error:
        return save_error
    return _mutation(before, after, executed=True, verified=True)


def _import_media(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    project = _current_project(resolve)
    paths = [Path(str(value)).expanduser() for value in args["paths"]]
    if not paths or any(not p.is_absolute() or not p.is_file() for p in paths):
        raise AdapterError("INVALID_MEDIA_PATH", "Every media path must be an existing absolute file path.")
    target = project.media.ensure_folder_path(AI_BIN)
    before = [{"path": clip.file_path, "unique_id": _identity(clip)} for clip in target.clips]
    imported: list[dict[str, Any]] = []
    executed = False
    try:
        for source in paths:
            clip = project.media.find_or_import(str(source), folder=target)
            executed = True
            imported.append({"path": clip.file_path, "name": clip.name, "unique_id": _identity(clip)})
    except Exception as exc:
        after = [{"path": clip.file_path, "unique_id": _identity(clip)} for clip in target.clips]
        return _ambiguous(before, after, f"Media import raised after one or more calls: {exc}") if executed else _mutation(before, after, executed=False, verified=False, error={"code": "MEDIA_IMPORT_FAILED", "message": str(exc)})
    verified = len(imported) == len(paths) and all(row["unique_id"] and Path(row["path"]).resolve() == source.resolve() for row, source in zip(imported, paths))
    registry = _load_registry()
    for row in imported:
        if row["unique_id"]:
            registry["media"][row["unique_id"]] = {**row, "project_unique_id": _identity(project), "recorded_at": time.time()}
    _save_registry(registry)
    after = imported
    if not verified:
        return _ambiguous(before, after, "Imported media could not be verified by path and unique ID.")
    save_error = _save_verified_project(project, before, after, "Media import")
    if save_error:
        return save_error
    return _mutation(before, after, executed=True, verified=True)


def _guard_assembly(resolve: Any, project: Any, timeline: Any, args: dict[str, Any]) -> None:
    keys = ("guard_version", "expected_project_unique_id", "expected_snapshot_sha256")
    if not any(key in args for key in keys):
        return  # Existing manually invoked adapter contract; S7.5 always supplies all guard fields.
    if not all(key in args for key in keys) or args["guard_version"] not in (1, ${VIDEO_ACCEPTANCE_GUARD_VERSION}):
        raise AdapterError("CAPABILITY_UNAVAILABLE", "Complete guarded append contract required.")
    if _identity(_current_project(resolve)) != args["expected_project_unique_id"] or _identity(project) != args["expected_project_unique_id"]:
        raise AdapterError("TARGET_PROJECT_MISMATCH", "The reviewed project is no longer current.")
    state = _timeline_observation(project, timeline, 0, 100)
    if state["snapshot_sha256"] != args["expected_snapshot_sha256"]:
        raise AdapterError("PRE_STATE_CHANGED", "Timeline differs from the reviewed complete snapshot.")
    if state["ownership"]["status"] != "AI_OWNED" or state["ownership"]["source_timeline_unique_id"] is not None:
        raise AdapterError("TARGET_NOT_AI_OWNED", "A fresh adapter-owned timeline is required.")
    if state["total"] != 0 or state["duration_frames"] != 0:
        raise AdapterError("TARGET_NOT_EMPTY", "First acceptance requires an empty timeline.")
    isolated = str(project.name).startswith("${VIDEO_ACCEPTANCE_PROJECT_PREFIX}") or (args["guard_version"] == ${VIDEO_ACCEPTANCE_GUARD_VERSION} and str(timeline.name).startswith("${VIDEO_ACCEPTANCE_TIMELINE_PREFIX}"))
    if not state["complete"] or not isolated:
        raise AdapterError("CAPABILITY_UNAVAILABLE", "Complete observation and dedicated acceptance project or acceptance timeline required.")


def _assemble(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    project = _current_project(resolve)
    timeline, _ = _owned_timeline(project, str(args["timeline_unique_id"]))
    _guard_assembly(resolve, project, timeline, args)
    requested = list(args["segments"])
    before = _item_snapshot(timeline)
    payload: list[dict[str, Any]] = []
    expected_names: list[str] = []
    for segment in requested:
        clip = _find_media(project, str(segment["media_unique_id"]))
        if clip is None:
            raise AdapterError("MEDIA_ID_NOT_FOUND", "A requested media unique ID is not observable in the current project.", state={"media_unique_id": segment["media_unique_id"]})
        entry: dict[str, Any] = {"mediaPoolItem": clip.raw}
        for key, resolve_key in (("start_frame", "startFrame"), ("end_frame", "endFrame"), ("record_frame", "recordFrame"), ("track_index", "trackIndex")):
            if key in segment:
                entry[resolve_key] = int(segment[key])
        # The adapter's source_end contract is inclusive; Resolve 21.1.1 append
        # uses an exclusive source end (confirmed by native GetEnd/GetDuration).
        # Convert once here; source observations retain their measured bounds.
        if "endFrame" in entry:
            entry["endFrame"] += 1
        if segment.get("media_type"):
            entry["mediaType"] = 1 if segment["media_type"] == "video" else 2
        payload.append(entry)
        expected_names.append(clip.name)
    _guard_assembly(resolve, project, timeline, args)
    project.timeline.set_current(timeline)
    if _identity(project.timeline.current) != _identity(timeline):
        raise AdapterError("TARGET_TIMELINE_MISMATCH", "Exact reviewed timeline selection could not be confirmed.")
    _guard_assembly(resolve, project, timeline, args)
    try:
        appended = project.media.append_to_timeline(payload)
    except Exception as exc:
        return _ambiguous(before, _item_snapshot(timeline), f"AppendToTimeline failed after dispatch: {exc}")
    after = _item_snapshot(timeline)
    delta = after[len(before):]
    verified = len(appended) == len(payload) and len(after) >= len(before) + len(payload) and [row["name"] for row in delta[:len(payload)]] == expected_names
    if not verified:
        return _ambiguous(before, after, "Rough-cut clip count/order verification did not match the requested segments.")
    save_error = _save_verified_project(project, before, after, "Rough-cut assembly")
    if save_error:
        return save_error
    return _mutation(before, after, executed=True, verified=True)


def _set_marker(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    project = _current_project(resolve)
    timeline, _ = _owned_timeline(project, str(args["timeline_unique_id"]))
    operation_id = str(args["operation_id"])
    frame = int(args["frame"])
    custom_data = f"cos:{operation_id}"
    before = dict(timeline.markers() or {})
    for marker_frame, marker in before.items():
        if str(marker.get("customData", marker.get("custom_data", ""))) == custom_data:
            return _mutation(before, before, executed=False, verified=True, warnings=["Operation marker already exists; no replay performed."])
    try:
        timeline.add_marker(frame, color=str(args.get("color", "Blue")), name=str(args.get("name", "")), note=str(args.get("note", "")), duration=int(args.get("duration", 1)), custom_data=custom_data)
    except Exception as exc:
        return _mutation(before, dict(timeline.markers() or {}), executed=False, verified=False, error={"code": "MARKER_SET_FAILED", "message": str(exc)})
    after = dict(timeline.markers() or {})
    marker = after.get(frame) or after.get(str(frame))
    verified = bool(marker) and str(marker.get("customData", marker.get("custom_data", ""))) == custom_data
    if not verified:
        return _ambiguous(before, after, "Marker call returned but the marker was not found by its operation identity.")
    save_error = _save_verified_project(project, before, after, "Marker mutation")
    if save_error:
        return save_error
    return _mutation(before, after, executed=True, verified=True)


ALLOWED_CLIP_PROPERTIES = frozenset({"pan", "tilt", "zoom", "zoom_x", "zoom_y", "rotation", "anchor_x", "anchor_y", "pitch", "yaw", "flip_x", "flip_y", "opacity"})


def _set_clip_properties(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    project = _current_project(resolve)
    timeline, _ = _owned_timeline(project, str(args["timeline_unique_id"]))
    item_id = str(args["item_unique_id"])
    item = next((candidate for candidate in _items(timeline) if _identity(candidate) == item_id), None)
    if item is None:
        raise AdapterError("STALE_TIMELINE_ITEM_ID", "Timeline item unique ID is not currently observable.")
    properties = dict(args["properties"])
    unexpected = sorted(set(properties) - ALLOWED_CLIP_PROPERTIES)
    if unexpected:
        raise AdapterError("UNSUPPORTED_CLIP_PROPERTY", "Only the reviewed basic static transform/composite property subset is allowed.", state={"unsupported": unexpected, "allowed": sorted(ALLOWED_CLIP_PROPERTIES)})
    from dvr import schema as schema_mod
    normalized = schema_mod.normalize_clip_properties(properties)
    before_all = dict(item.get_property() or {})
    before = {key: before_all.get(key) for key in normalized}
    try:
        results = item.set_properties(properties, raise_on_failure=False)
    except Exception as exc:
        return _mutation(before, dict(item.get_property() or {}), executed=False, verified=False, error={"code": "CLIP_PROPERTY_SET_FAILED", "message": str(exc)})
    after_all = dict(item.get_property() or {})
    after = {key: after_all.get(key) for key in normalized}
    executed = any(bool(value) for value in results.values())
    verified = bool(results) and all(bool(value) for value in results.values()) and all(str(after_all.get(key)) == str(value) for key, value in normalized.items())
    if executed and not verified:
        return _ambiguous(before, after, "One or more clip properties executed but did not read back to the requested value.")
    if verified:
        save_error = _save_verified_project(project, before, after, "Clip-property mutation")
        if save_error:
            return save_error
    return _mutation(before, after, executed=executed, verified=verified, error=None if verified else {"code": "CLIP_PROPERTY_REJECTED", "message": "Resolve rejected one or more requested properties."})


def _render_review(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    project = _current_project(resolve)
    timeline, _ = _owned_timeline(project, str(args["timeline_unique_id"]))
    project.timeline.set_current(timeline.name)
    operation_id = _sanitize(str(args["operation_id"]))
    registry = _load_registry()
    prior = registry["renders"].get(operation_id)
    if prior:
        return _mutation(prior, prior, executed=False, verified=True, warnings=["Render operation ID already exists; no replay performed."])
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    custom_name = f"review_{operation_id}"
    if any(REVIEW_ROOT.glob(custom_name + ".*")):
        raise AdapterError("REVIEW_OUTPUT_EXISTS", "Review output already exists; silent overwrite is forbidden.")
    before = list(resolve.render.queue())
    try:
        job = resolve.render.submit(target_dir=str(REVIEW_ROOT), custom_name=custom_name, preset=args.get("preset"), format=args.get("format"), codec=args.get("codec"), start=bool(args.get("start", True)))
    except Exception as exc:
        return _mutation(before, list(resolve.render.queue()), executed=False, verified=False, error={"code": "RENDER_SUBMIT_FAILED", "message": str(exc)})
    after = list(resolve.render.queue())
    expected = job.output_path
    queue_match = next((entry for entry in after if str(entry.get("JobId")) == str(job.id)), None)
    expected = expected or (queue_match or {}).get("OutputFilename")
    record = {"job_id": str(job.id), "timeline_unique_id": _identity(timeline), "expected_output_path": expected, "operation_id": operation_id, "created_at": time.time()}
    registry["renders"][operation_id] = record
    _save_registry(registry)
    verified = queue_match is not None and bool(expected)
    if not verified:
        return _ambiguous(before, {"queue": after, "record": record}, "Render job was submitted but job identity/output path could not both be verified.")
    return _mutation(before, record, executed=True, verified=True)


def _render_status(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    job_id = str(args["job_id"])
    registry = _load_registry()
    record = next((entry for entry in registry["renders"].values() if str(entry.get("job_id")) == job_id), None)
    if record is None:
        raise AdapterError("RENDER_JOB_NOT_AI_OWNED", "Render job is not present in the adapter ownership registry.", state={"job_id": job_id})
    status = resolve.render.status(job_id)
    output = status.get("output_path")
    complete = status.get("status") == "Complete"
    expected = record.get("expected_output_path")
    output_matches = bool(output and expected and Path(str(output)).resolve() == Path(str(expected)).resolve())
    artifact_exists = bool(output and Path(str(output)).is_file())
    artifact_verified = bool(complete and output_matches and artifact_exists and Path(str(output)).stat().st_size > 0)
    return {
        **status,
        "job_id": job_id,
        "operation_id": record["operation_id"],
        "timeline_unique_id": record["timeline_unique_id"],
        "expected_output_path": expected,
        "output_path_matches_expected": output_matches,
        "verified": artifact_verified if complete else False,
        "artifact_exists": artifact_exists,
    }


def _capture_frame(args: dict[str, Any]) -> dict[str, Any]:
    resolve = _connect()
    project = _current_project(resolve)
    timeline, _ = _owned_timeline(project, str(args["timeline_unique_id"]))
    project.timeline.set_current(timeline.name)
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    operation_id = _sanitize(str(args["operation_id"]))
    output = REVIEW_ROOT / f"frame_{operation_id}.png"
    if output.exists():
        raise AdapterError("REVIEW_OUTPUT_EXISTS", "Frame capture output already exists; silent overwrite is forbidden.")
    before = {"exists": False, "path": str(output)}
    try:
        project.export_current_frame_as_still(str(output))
    except Exception as exc:
        return _mutation(before, {"exists": output.exists(), "path": str(output)}, executed=False, verified=False, error={"code": "FRAME_CAPTURE_FAILED", "message": str(exc)})
    after = {"exists": output.is_file(), "non_empty": output.is_file() and output.stat().st_size > 0, "path": str(output),
             "timeline_unique_id": _identity(timeline), "project_unique_id": _identity(project)}
    if not after["non_empty"]:
        return _ambiguous(before, after, "Still export returned but the expected non-empty file was not found.")
    return _mutation(before, after, executed=True, verified=True)


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Any]


def _registry() -> list[ToolSpec]:
    return [
        ToolSpec("resolve_health", "Diagnose the local Resolve backend without mutating it.", _schema(), _health),
        ToolSpec("resolve_inspect", "Read bounded project, timeline, or media state.", _schema({"selector": {"type": "string", "enum": ["project", "timelines", "timeline", "media"], "default": "project"}, "timeline_unique_id": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}), _inspect),
        ToolSpec("resolve_prepare_ai_timeline", "Create or duplicate one timeline and durably register it as AI-owned.", _schema({"operation_id": {"type": "string", "minLength": 1}, "name": {"type": "string"}, "source_timeline_unique_id": {"type": "string"}}, required=["operation_id"]), _prepare),
        ToolSpec("resolve_import_media", "Import explicit existing absolute media paths into the adapter-owned bin and verify identities.", _schema({"paths": {"type": "array", "minItems": 1, "maxItems": 100, "items": {"type": "string"}}}, required=["paths"]), _import_media),
        ToolSpec("resolve_assemble_rough_cut", "Append an explicit ordered segment list to an AI-owned timeline and verify order/count.", _schema({"timeline_unique_id": {"type": "string"}, "guard_version": {"type": "integer", "enum": [1, ${VIDEO_ACCEPTANCE_GUARD_VERSION}]}, "expected_project_unique_id": {"type": "string", "minLength": 1}, "expected_snapshot_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"}, "segments": {"type": "array", "minItems": 1, "maxItems": 500, "items": {"type": "object", "additionalProperties": False, "required": ["media_unique_id"], "properties": {"media_unique_id": {"type": "string"}, "start_frame": {"type": "integer"}, "end_frame": {"type": "integer"}, "record_frame": {"type": "integer"}, "track_index": {"type": "integer", "minimum": 1}, "media_type": {"type": "string", "enum": ["video", "audio"]}}}}}, required=["timeline_unique_id", "segments"]), _assemble),
        ToolSpec("resolve_set_marker", "Set one operation-identified marker on an AI-owned timeline and read it back.", _schema({"timeline_unique_id": {"type": "string"}, "operation_id": {"type": "string"}, "frame": {"type": "integer"}, "color": {"type": "string", "default": "Blue"}, "name": {"type": "string"}, "note": {"type": "string"}, "duration": {"type": "integer", "minimum": 1}}, required=["timeline_unique_id", "operation_id", "frame"]), _set_marker),
        ToolSpec("resolve_set_basic_clip_properties", "Set the reviewed static transform/composite subset on one AI-owned timeline item and read it back.", _schema({"timeline_unique_id": {"type": "string"}, "item_unique_id": {"type": "string"}, "properties": {"type": "object", "minProperties": 1, "additionalProperties": {"type": ["number", "boolean"]}}}, required=["timeline_unique_id", "item_unique_id", "properties"]), _set_clip_properties),
        ToolSpec("resolve_render_review", "Queue/start a review render for an AI-owned timeline in plugin-owned storage without overwrite.", _schema({"timeline_unique_id": {"type": "string"}, "operation_id": {"type": "string"}, "preset": {"type": "string"}, "format": {"type": "string"}, "codec": {"type": "string"}, "start": {"type": "boolean", "default": True}}, required=["timeline_unique_id", "operation_id"]), _render_review),
        ToolSpec("resolve_render_status", "Read a render job and verify its output artifact when complete.", _schema({"job_id": {"type": "string"}}, required=["job_id"]), _render_status),
        ToolSpec("resolve_capture_frame", "Export the current frame of an AI-owned timeline into plugin-owned review storage and verify the file.", _schema({"timeline_unique_id": {"type": "string"}, "operation_id": {"type": "string"}}, required=["timeline_unique_id", "operation_id"]), _capture_frame),
    ]


def _serialize(value: Any) -> str:
    return json.dumps(value, indent=2, default=str)


async def _run() -> None:
    try:
        from mcp.server import Server, ServerRequestContext
        from mcp.server.stdio import stdio_server
        from mcp.types import CallToolRequestParams, CallToolResult, ListToolsResult, PaginatedRequestParams, TextContent, Tool
    except ImportError as exc:
        raise SystemExit(f"dvr MCP dependency is unavailable: {exc}")

    specs = _registry()
    if tuple(spec.name for spec in specs) != PUBLIC_TOOLS:
        raise SystemExit("internal tool registry does not match the reviewed public surface")
    by_name = {spec.name: spec for spec in specs}
    tools = [Tool(name=spec.name, description=spec.description, input_schema=spec.schema) for spec in specs]

    async def list_tools(_ctx: ServerRequestContext[Any], _params: PaginatedRequestParams | None) -> ListToolsResult:
        return ListToolsResult(tools=tools)

    async def call_tool(_ctx: ServerRequestContext[Any], params: CallToolRequestParams) -> CallToolResult:
        spec = by_name.get(params.name)
        if spec is None:
            return CallToolResult(content=[TextContent(type="text", text=_serialize({"error": {"code": "UNKNOWN_TOOL", "message": params.name}}))], is_error=True)
        try:
            value = spec.handler(dict(params.arguments or {}))
            return CallToolResult(content=[TextContent(type="text", text=_serialize(value))])
        except AdapterError as exc:
            return CallToolResult(content=[TextContent(type="text", text=_serialize({"error": {"code": exc.code, "message": str(exc), "state": exc.state}}))], is_error=True)
        except BaseException as exc:
            return CallToolResult(content=[TextContent(type="text", text=_serialize({"error": {"code": "ADAPTER_ERROR", "message": f"{type(exc).__name__}: {exc}"}}))], is_error=True)

    server = Server("cos-davinci-resolve", version=ADAPTER_VERSION, on_list_tools=list_tools, on_call_tool=call_tool)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(_run())
`;
