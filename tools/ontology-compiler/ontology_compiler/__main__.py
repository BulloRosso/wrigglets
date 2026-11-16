"""CLI of the ontology compiler.

  python -m ontology_compiler compile <ontology dir> -o <ir.json>   compile; exit 1 with errors on stderr
  python -m ontology_compiler serve [--port 7720]                   HTTP: POST /compile {files: {schema.yaml, actions.yaml,
                                                                    bindings.yaml}} -> {ok, ir} | {ok: false, errors};
                                                                    POST /check-rego {files: {<path>: text}} -> opa check + opa test
                                                                    (policies in config proposals, M6);
                                                                    GET /health. Used by the ontology editor (E2) and
                                                                    the config reconciler.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .compiler import SOURCES, CompileError, compile_dir, compile_sources, dumps

MAX_BODY = 2 * 1024 * 1024


def cmd_compile(args: argparse.Namespace) -> int:
    try:
        ir = compile_dir(Path(args.src))
    except CompileError as e:
        for x in e.errors:
            print(f"error: {x['path']}: {x['message']}", file=sys.stderr)
        return 1
    text = dumps(ir)
    if args.out == "-":
        sys.stdout.write(text)
    else:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8", newline="\n")
        print(f"ontology {ir['name']}@{ir['version']}: {len(ir['classes'])} classes, {len(ir['actions'])} actions, hash {ir['hash'][:12]}", file=sys.stderr)
    return 0


class Handler(BaseHTTPRequestHandler):
    token = os.environ.get("COMPILER_TOKEN", "")

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:  # noqa: D102 - quieter logs
        sys.stderr.write(json.dumps({"msg": fmt % args}) + "\n")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            return self._send(200, {"status": "ok"})
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/compile", "/check-rego"):
            return self._send(404, {"error": "not found"})
        if self.token and self.headers.get("authorization", "") != f"Bearer {self.token}":
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "body too large or empty"})
        if self.path == "/check-rego":
            return self._check_rego(length)
        try:
            files = json.loads(self.rfile.read(length))["files"]
            if not all(isinstance(files.get(n), str) for n in SOURCES):
                raise ValueError
        except Exception:  # noqa: BLE001
            return self._send(400, {"error": f"expected {{files: {{{', '.join(SOURCES)}}}}} as strings"})
        with tempfile.TemporaryDirectory() as tmp:
            for n in SOURCES:
                Path(tmp, n).write_text(files[n], encoding="utf-8", newline="\n")
            try:
                ir = compile_sources(Path(tmp, "schema.yaml"), {n: files[n] for n in SOURCES})
            except CompileError as e:
                return self._send(200, {"ok": False, "errors": e.errors})
        self._send(200, {"ok": True, "ir": ir})


    def _check_rego(self, length: int) -> None:
        try:
            files = json.loads(self.rfile.read(length))["files"]
            if not isinstance(files, dict) or not files or not all(isinstance(k, str) and isinstance(v, str) for k, v in files.items()):
                raise ValueError
            if any(not SAFE_PATH.match(k) or ".." in k.split("/") for k in files):
                raise ValueError
        except Exception:  # noqa: BLE001
            return self._send(400, {"error": "expected {files: {<relative path .rego|.json>: text}}"})
        with tempfile.TemporaryDirectory() as tmp:
            for k, v in files.items():
                Path(tmp, k).parent.mkdir(parents=True, exist_ok=True)
                Path(tmp, k).write_text(v, encoding="utf-8", newline="\n")
            errors: list[dict] = []
            for step in (["check", "--strict"], ["test"]):
                r = subprocess.run([OPA, *step, "."], cwd=tmp, capture_output=True, text=True, timeout=60)
                if r.returncode != 0:
                    errors.append({"path": f"opa {step[0]}", "message": (r.stdout + r.stderr).strip()[:4000]})
                    break
        self._send(200, {"ok": not errors, "errors": errors})


SAFE_PATH = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}\.(rego|json)$")
OPA = os.environ.get("OPA_BIN", "/usr/local/bin/opa")


def cmd_serve(args: argparse.Namespace) -> int:
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(json.dumps({"msg": "ontology compiler listening", "port": args.port}), file=sys.stderr)
    server.serve_forever()
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="ontology_compiler")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("compile")
    c.add_argument("src")
    c.add_argument("-o", "--out", default="-")
    c.set_defaults(fn=cmd_compile)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=int(os.environ.get("PORT", "7720")))
    s.set_defaults(fn=cmd_serve)
    args = p.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
