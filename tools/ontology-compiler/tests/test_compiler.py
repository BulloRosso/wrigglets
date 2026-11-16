"""Compiler tests (run during the image build: python -m unittest discover -s tests)."""
from __future__ import annotations

import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from ontology_compiler.compiler import CompileError, canonical, compile_dir

ROOT = Path(__file__).resolve().parents[1]
_parents = Path(__file__).resolve().parents
# in the repository: <repo>/tools/ontology-compiler/tests; in the image the sofa ontology is copied to tests/fixture
SOFA = _parents[3] / "ontology" / "sofa" if len(_parents) > 3 else Path("/nonexistent")
FIXTURE = ROOT / "tests" / "fixture"


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        src = SOFA if SOFA.is_dir() else FIXTURE
        for f in ("schema.yaml", "actions.yaml", "bindings.yaml"):
            shutil.copy(src / f, self.tmp / f)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self, name: str, old: str, new: str) -> None:
        p = self.tmp / name
        text = p.read_text(encoding="utf-8")
        self.assertIn(old, text, f"fixture text not found in {name}")
        p.write_text(text.replace(old, new, 1), encoding="utf-8")

    def errors(self) -> list[str]:
        with self.assertRaises(CompileError) as ctx:
            compile_dir(self.tmp)
        return [f"{e['path']}: {e['message']}" for e in ctx.exception.errors]


class CompileOk(Base):
    def test_compiles_and_is_deterministic(self) -> None:
        a = compile_dir(self.tmp)
        b = compile_dir(self.tmp)
        self.assertEqual(canonical(a), canonical(b))
        self.assertRegex(a["hash"], r"^[0-9a-f]{64}$")
        self.assertEqual(a["irVersion"], 1)

    def test_hash_covers_content(self) -> None:
        a = compile_dir(self.tmp)
        self.edit("schema.yaml", "description: A plant that produces sofas.", "description: A plant.")
        b = compile_dir(self.tmp)
        self.assertNotEqual(a["hash"], b["hash"])
        self.assertNotEqual(a["source"]["files"]["schema.yaml"], b["source"]["files"]["schema.yaml"])

    def test_links_and_identifiers(self) -> None:
        ir = compile_dir(self.tmp)
        factory = next(c for c in ir["classes"] if c["name"] == "Factory")
        self.assertEqual(factory["identifier"], "id")
        self.assertIn({"from": "Machine", "attribute": "factory", "to": "Factory", "required": True, "multivalued": False}, ir["links"])

    def test_identifier_is_required(self) -> None:
        ir = compile_dir(self.tmp)
        for c in ir["classes"]:
            ident = next(a for a in c["attributes"] if a["identifier"])
            self.assertTrue(ident["required"], c["name"])


class CompileErrors(Base):
    def test_unknown_class_in_action(self) -> None:
        self.edit("actions.yaml", "target: PurchaseOrder\n    kind: create", "target: Order\n    kind: create")
        self.assertTrue(any("unknown class 'Order'" in e for e in self.errors()))

    def test_unknown_event(self) -> None:
        self.edit("actions.yaml", "emits: [PurchaseOrderCreated]", "emits: [PurchaseOrderMade]")
        self.assertTrue(any("unknown event 'PurchaseOrderMade'" in e for e in self.errors()))

    def test_write_action_must_emit(self) -> None:
        self.edit("actions.yaml", "    emits: [PurchaseOrderCreated]\n", "")
        self.assertTrue(any("must emit at least one event" in e for e in self.errors()))

    def test_binding_to_unknown_attribute(self) -> None:
        self.edit("bindings.yaml", "columns: { supplier: supplier_id }", "columns: { vendor: supplier_id }")
        self.assertTrue(any("'vendor' is not an attribute of PurchaseOrder" in e for e in self.errors()))

    def test_binding_to_unknown_class(self) -> None:
        self.edit("bindings.yaml", "- { class: Factory, table: erp_factories, key: id }", "- { class: Plant, table: erp_factories, key: id }")
        self.assertTrue(any("unknown class 'Plant'" in e for e in self.errors()))

    def test_unknown_range(self) -> None:
        self.edit("schema.yaml", "rate_per_day: { range: integer", "rate_per_day: { range: int")
        self.assertTrue(any("unknown range 'int'" in e for e in self.errors()))

    def test_missing_annotation(self) -> None:
        self.edit("schema.yaml", "criticality: payment_critical, ", "")
        self.assertTrue(any("annotations.criticality" in e for e in self.errors()))

    def test_query_must_be_read_only(self) -> None:
        self.edit("actions.yaml", "  - name: get_kpi\n    kind: query\n    read_only: true", "  - name: get_kpi\n    kind: query")
        self.assertTrue(any("go together" in e for e in self.errors()))

    def test_unknown_action_key(self) -> None:
        self.edit("actions.yaml", "  - name: get_kpi\n", "  - name: get_kpi\n    readonly: true\n")
        self.assertTrue(any("unknown key 'readonly'" in e for e in self.errors()))

    def test_errors_are_collected_not_first_only(self) -> None:
        self.edit("actions.yaml", "emits: [PurchaseOrderCreated]", "emits: [Nope]")
        self.edit("bindings.yaml", "columns: { supplier: supplier_id }", "columns: { vendor: supplier_id }")
        self.assertGreaterEqual(len(self.errors()), 2)


class Canonical(unittest.TestCase):
    def test_matches_typescript_canonical_form(self) -> None:
        # same rules as packages/ontology-ir canonical(): sorted keys, no spaces, UTF-8 kept
        self.assertEqual(canonical({"b": [1, 4.2, "Süd"], "a": {"d": None, "c": True}}), '{"a":{"c":true,"d":null},"b":[1,4.2,"Süd"]}')


if __name__ == "__main__":
    unittest.main()
