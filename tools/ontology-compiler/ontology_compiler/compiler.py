"""Ontology compiler front end (ADR-0041): LinkML schema + actions.yaml + bindings.yaml -> ontology IR (JSON).

The IR is the contract every generator reads (packages/ontology-ir). Output is deterministic: lists keep the declared
order, objects are serialised with sorted keys, and the IR carries a content hash plus the hashes of its source files.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from linkml_runtime.utils.schemaview import SchemaView

IR_VERSION = 1
SCALARS = {"string", "integer", "float", "boolean", "date", "datetime"}
INPUT_SCALARS = SCALARS | {"json"}
CRITICALITY = {"normal", "business_critical", "payment_critical"}
DATA_CLASS = {"public", "internal", "confidential"}
KINDS = {"query", "create", "update", "delete", "command"}
TRANSFORMS = {"json_array", "json_field_description"}
NAME = re.compile(r"^[A-Z][A-Za-z0-9]{1,80}$")
ACTION = re.compile(r"^[a-z][a-z0-9_]{1,80}$")
FIELD = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,80}$")
SOURCES = ("schema.yaml", "actions.yaml", "bindings.yaml")


@dataclass
class CompileError(Exception):
    errors: list[dict[str, str]] = field(default_factory=list)

    def __str__(self) -> str:
        return "\n".join(f"{e['path']}: {e['message']}" for e in self.errors)


def _sha(text: str) -> str:
    return hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def canonical(obj: Any) -> str:
    """Canonical JSON (sorted keys, no whitespace, UTF-8); identical to the TypeScript side (packages/ontology-ir)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def compile_dir(src: Path) -> dict[str, Any]:
    texts = {}
    for name in SOURCES:
        p = src / name
        if not p.is_file():
            raise CompileError([{"path": name, "message": "file is missing"}])
        texts[name] = p.read_text(encoding="utf-8")
    return compile_sources(src / "schema.yaml", texts)


def compile_sources(schema_path: Path, texts: dict[str, str]) -> dict[str, Any]:
    errors: list[dict[str, str]] = []

    def err(path: str, message: str) -> None:
        errors.append({"path": path, "message": message})

    try:
        sv = SchemaView(str(schema_path))
    except Exception as e:  # noqa: BLE001 - LinkML raises many types
        raise CompileError([{"path": "schema.yaml", "message": f"LinkML could not load the schema: {e}"}]) from e
    try:
        actions_doc = yaml.safe_load(texts["actions.yaml"]) or {}
        bindings_doc = yaml.safe_load(texts["bindings.yaml"]) or {}
    except yaml.YAMLError as e:
        raise CompileError([{"path": "actions.yaml/bindings.yaml", "message": f"invalid YAML: {e}"}]) from e

    schema = sv.schema
    if not schema.version or not re.match(r"^\d+\.\d+\.\d+$", str(schema.version)):
        err("schema.yaml#version", "version must be semver (x.y.z)")
    for doc, name in ((actions_doc, "actions.yaml"), (bindings_doc, "bindings.yaml")):
        if doc.get("ontology") != schema.name:
            err(f"{name}#ontology", f"must be '{schema.name}' (the schema name)")

    # ------------------------------------------------------------------ enums
    enums = []
    enum_names = set()
    for en, e in sv.all_enums(imports=False).items():
        if not NAME.match(en):
            err(f"enums.{en}", "enum names are PascalCase")
        enum_names.add(en)
        enums.append(_clean({
            "name": en,
            "description": e.description,
            "values": [_clean({"value": str(k), "description": v.description}) for k, v in e.permissible_values.items()],
        }))

    # ------------------------------------------------------------------ classes
    class_defs = sv.all_classes(imports=False)
    class_names = set(class_defs)
    classes = []
    links = []
    attrs_of: dict[str, dict[str, dict[str, Any]]] = {}
    for cn, c in class_defs.items():
        path = f"classes.{cn}"
        if not NAME.match(cn):
            err(path, "class names are PascalCase")
        ann = {k: str(v.value) for k, v in c.annotations.items()}
        if ann.get("criticality") not in CRITICALITY:
            err(f"{path}.annotations.criticality", f"one of {sorted(CRITICALITY)}")
        if ann.get("data_class") not in DATA_CLASS:
            err(f"{path}.annotations.data_class", f"one of {sorted(DATA_CLASS)}")
        if not ann.get("owner"):
            err(f"{path}.annotations.owner", "required (role that approves structural changes)")
        attributes = []
        identifier = None
        for s in sv.class_induced_slots(cn):
            rng = s.range or "string"
            kind = "class" if rng in class_names else "enum" if rng in enum_names else "type" if rng in SCALARS else None
            if kind is None:
                err(f"{path}.attributes.{s.name}.range", f"unknown range '{rng}' (types: {sorted(SCALARS)}, or an enum/class)")
                kind = "type"
            is_id = bool(s.identifier)
            if is_id:
                if identifier:
                    err(f"{path}.attributes.{s.name}", f"second identifier (already '{identifier}')")
                identifier = s.name
            a = _clean({
                "name": s.name,
                "range": rng,
                "rangeKind": kind,
                "required": bool(s.required) or is_id,
                "multivalued": bool(s.multivalued),
                "identifier": is_id,
                "description": s.description,
            })
            attributes.append(a)
            if kind == "class":
                links.append({"from": cn, "attribute": s.name, "to": rng, "required": a["required"], "multivalued": a["multivalued"]})
        if not identifier:
            err(path, "needs exactly one identifier attribute")
        attrs_of[cn] = {a["name"]: a for a in attributes}
        classes.append(_clean({
            "name": cn,
            "description": c.description,
            "identifier": identifier or "",
            "annotations": _clean({k: ann.get(k) for k in ("criticality", "data_class", "owner", "mcp_group")}),
            "attributes": attributes,
        }))

    # ------------------------------------------------------------------ events
    events = []
    event_names = set()
    for i, e in enumerate(actions_doc.get("events") or []):
        path = f"actions.yaml#events[{i}]"
        if not isinstance(e, dict) or set(e) - {"name", "object_type", "description"}:
            err(path, "allowed keys: name, object_type, description")
            continue
        if not NAME.match(str(e.get("name", ""))):
            err(path, "event names are PascalCase")
        if e.get("object_type") not in class_names:
            err(path, f"unknown object_type '{e.get('object_type')}'")
        if e.get("name") in event_names:
            err(path, f"duplicate event '{e.get('name')}'")
        event_names.add(e.get("name"))
        events.append(_clean({"name": e.get("name"), "objectType": e.get("object_type"), "description": e.get("description")}))

    # ------------------------------------------------------------------ actions
    actions = []
    action_names = set()
    allowed_action = {"name", "description", "target", "kind", "read_only", "destructive", "mcp_group", "input", "preconditions", "emits", "starts_workflow", "signals_workflow"}
    for i, a in enumerate(actions_doc.get("actions") or []):
        name = a.get("name") if isinstance(a, dict) else None
        path = f"actions.yaml#{name or f'actions[{i}]'}"
        if not isinstance(a, dict):
            err(path, "an action is a mapping")
            continue
        for k in set(a) - allowed_action:
            err(path, f"unknown key '{k}'")
        if not ACTION.match(str(name or "")):
            err(path, "action names are snake_case")
        if name in action_names:
            err(path, "duplicate action")
        action_names.add(name)
        kind = a.get("kind")
        if kind not in KINDS:
            err(f"{path}.kind", f"one of {sorted(KINDS)}")
        read_only = bool(a.get("read_only", False))
        if (kind == "query") != read_only:
            err(path, "kind 'query' and read_only: true go together")
        if read_only and a.get("destructive"):
            err(path, "a read-only action cannot be destructive")
        if a.get("target") is not None and a["target"] not in class_names:
            err(f"{path}.target", f"unknown class '{a['target']}'")
        if not a.get("description"):
            err(f"{path}.description", "required")
        inputs = []
        for fname, f in (a.get("input") or {}).items():
            fpath = f"{path}.input.{fname}"
            if not FIELD.match(fname):
                err(fpath, "field names are identifiers")
            f = f or {}
            for k in set(f) - {"range", "required", "multivalued", "description", "enum"}:
                err(fpath, f"unknown key '{k}'")
            rng = f.get("range", "string")
            kind_ = "class" if rng in class_names else "enum" if rng in enum_names else "type" if rng in INPUT_SCALARS else None
            if kind_ is None:
                err(f"{fpath}.range", f"unknown range '{rng}'")
                kind_ = "type"
            enum = f.get("enum")
            if enum is not None and (not isinstance(enum, list) or not all(isinstance(x, str) for x in enum)):
                err(f"{fpath}.enum", "a list of strings")
            inputs.append(_clean({
                "name": fname,
                "range": rng,
                "rangeKind": kind_,
                "required": bool(f.get("required", False)),
                "multivalued": bool(f.get("multivalued", False)),
                "description": f.get("description"),
                "enum": enum,
            }))
        emits = list(a.get("emits") or [])
        for ev in emits:
            if ev not in event_names:
                err(f"{path}.emits", f"unknown event '{ev}'")
        if not read_only and not emits:
            err(f"{path}.emits", "a write action must emit at least one event")
        if read_only and emits:
            err(f"{path}.emits", "a read-only action emits no events")
        starts = a.get("starts_workflow")
        if starts is not None and (not isinstance(starts, str) or not NAME.match(starts)):
            err(f"{path}.starts_workflow", "a PascalCase workflow name")
        if starts is not None and read_only:
            err(f"{path}.starts_workflow", "a read-only action cannot start a workflow")
        signals = a.get("signals_workflow")
        if signals is not None:
            if not isinstance(signals, dict) or set(signals) != {"workflow", "signal"} or not NAME.match(str(signals.get("workflow"))) or not ACTION.match(str(signals.get("signal"))):
                err(f"{path}.signals_workflow", "{ workflow: PascalCase, signal: snake_case }")
        pre = list(a.get("preconditions") or [])
        for p in pre:
            if not ACTION.match(str(p)):
                err(f"{path}.preconditions", f"precondition names are snake_case: '{p}'")
        actions.append(_clean({
            "name": name,
            "description": a.get("description"),
            "target": a.get("target"),
            "kind": kind,
            "readOnly": read_only,
            "destructive": bool(a.get("destructive", False)),
            "mcpGroup": a.get("mcp_group"),
            "input": inputs,
            "preconditions": pre,
            "emits": emits,
            "startsWorkflow": starts,
            "signalsWorkflow": signals,
        }))

    # ------------------------------------------------------------------ bindings
    bindings = []
    bound = set()
    for i, b in enumerate(bindings_doc.get("bindings") or []):
        cn = b.get("class") if isinstance(b, dict) else None
        path = f"bindings.yaml#{cn or f'bindings[{i}]'}"
        if not isinstance(b, dict):
            err(path, "a binding is a mapping")
            continue
        for k in set(b) - {"class", "table", "key", "columns", "transforms", "id_template"}:
            err(path, f"unknown key '{k}'")
        if cn not in class_names:
            err(path, f"unknown class '{cn}'")
            continue
        if cn in bound:
            err(path, "class bound twice")
        bound.add(cn)
        table = str(b.get("table", ""))
        if not re.match(r"^(erp|crm)_[a-z0-9_]+$", table):
            err(f"{path}.table", "raw table name like erp_suppliers / crm_orders")
        key = b.get("key")
        key = key if isinstance(key, list) else [key]
        attrs = attrs_of[cn]
        cols = dict(b.get("columns") or {})
        for attr in cols:
            if attr not in attrs:
                err(f"{path}.columns.{attr}", f"'{attr}' is not an attribute of {cn}")
        transforms = dict(b.get("transforms") or {})
        for attr, t in transforms.items():
            if attr not in attrs:
                err(f"{path}.transforms.{attr}", f"'{attr}' is not an attribute of {cn}")
            if t not in TRANSFORMS:
                err(f"{path}.transforms.{attr}", f"unknown transform '{t}' (known: {sorted(TRANSFORMS)})")
        id_template = b.get("id_template")
        identifier = next((a["name"] for a in attrs.values() if a.get("identifier")), None)
        columns = {}
        for an in attrs:
            if an == identifier and id_template:
                continue
            columns[an] = cols.get(an, an)
        bindings.append(_clean({
            "class": cn,
            "table": table,
            "key": [str(k) for k in key],
            "columns": columns,
            "transforms": transforms or None,
            "idTemplate": id_template,
        }))

    if errors:
        raise CompileError(errors)

    files = {name: _sha(texts[name]) for name in SOURCES}
    ir: dict[str, Any] = _clean({
        "irVersion": IR_VERSION,
        "name": schema.name,
        "version": str(schema.version),
        "title": schema.title,
        "description": schema.description,
        "source": {"files": files, "hash": hashlib.sha256(canonical(files).encode("utf-8")).hexdigest()},
        "enums": enums,
        "classes": classes,
        "links": links,
        "events": events,
        "actions": actions,
        "bindings": bindings,
    })
    ir["hash"] = hashlib.sha256(canonical(ir).encode("utf-8")).hexdigest()
    return ir


def dumps(ir: dict[str, Any]) -> str:
    """Pretty, stable file form of the IR (the hash is computed on the canonical form, not on this text)."""
    return json.dumps(ir, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
