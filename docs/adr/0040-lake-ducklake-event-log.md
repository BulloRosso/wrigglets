# ADR-0040: Lake on DuckLake, event log in Postgres, DuckDB 2 embedded in the ontology server

- **Status:** Accepted
- **Date:** 2026-11-16
- **Extends:** [ADR-0038](0038-liquid-enterprise-extension.md), [ADR-0039](0039-extension-manager.md)
- **Supersedes in part:** the plan's M1 design (MinIO + Apache Iceberg REST catalog + a separate lake writer)

## Context

Plan M1 asks for an open-format raw zone and an append-only event log, both rebuildable, with the sofa company's initial
state seeded into them. The plan named MinIO + Iceberg with a REST catalog and a DuckDB or PyIceberg writer, all marked
"⚠ VERIFY".

What the verification found:

- **MinIO** stopped publishing community images and binaries in October 2025; the repository was archived in February
  2026. Not usable.
- **SeaweedFS** (Apache-2.0, ≥ 4.42) has S3 and a built-in Iceberg REST catalog, and DuckDB ≥ 1.4 can write Iceberg
  through a REST catalog. It would work, but adds an object store, a catalog endpoint, S3 credentials and their failure
  modes to a prototype whose point is the ontology, not storage.
- **DuckLake** (MIT, 1.0 since April 2026) keeps its catalog in a SQL database (we already run Postgres for the event
  log) and writes Parquet files to a directory. Spike results (2026-11-16, DuckDB 2.0.0 via `@duckdb/node-api`
  2.0.0-r.1, on Windows and in `node:24.22.1-bookworm-slim`): attach with a Postgres catalog in its own schema
  (`METADATA_SCHEMA 'lake_catalog'`), create/insert/read, 1,000 rows in ~70 ms, prepared statements, snapshots,
  `AT (VERSION => n)` time travel, Parquet files on disk; extensions installed at image build load without network.

## Decision

1. **No storage containers beyond `ontology-db`.** The event log, the DuckLake catalog (schema `lake_catalog`) and,
   from M3, the projection live in the extension's Postgres. Lake data files are Parquet in the volume `lake-data`
   (`/lake`).
2. **DuckLake is the table format of the raw zone.** Schema `raw`: `raw.events` (flushed event log), `raw.erp_*` and
   `raw.crm_*` (source system extracts with `_extract_id`, `_extracted_at`), `raw._extracts` (one row per extract).
   Raw data is never updated; an extract is written once (idempotent by extract id) in one transaction.
3. **DuckDB 2 is embedded** in `apps/ontology-server` (`@duckdb/node-api` 2.0.0-r.1, pinned; the user chose DuckDB 2
   over the 1.5 line). The `ducklake` and `postgres` extensions are installed at image build; production starts DuckDB
   with extension auto-install off. One connection, serialised by a mutex.
4. **The ontology server owns the event log from M1 on**; there is no separate lake writer. `packages/lake` holds the
   event store, the flush and the DuckLake access; `packages/sofa-domain` holds the sofa world (parity-tested against
   the mock) and its raw extract.
5. **Event log:** table `events` (`seq bigserial`, `event_id uuid unique`, type, object type/id, action, actor agent and
   user, task, workflow, `payload jsonb`, `occurred_at`, `recorded_at`, `ontology_version`). Append is one statement,
   zod-validated, idempotent by `event_id`. A trigger rejects UPDATE, DELETE and TRUNCATE for every role — stronger
   than withholding grants, and it also protects against the owner role.
6. **Flush:** every 60 s and on demand, under the process mutex. The high-water mark is `max(seq)` in `lake.raw.events`
   itself, so a flush is idempotent and survives restarts without extra state. A batch is the contiguous run after the
   mark; a sequence gap stops the batch unless the event after it was recorded more than 60 s ago (then the missing
   number belonged to a rolled-back insert). Each batch is one `INSERT … SELECT` from a staging table, i.e. one
   snapshot.
7. **Seed:** a demo-only bootstrap step `seed-sofa` of the extension calls the ontology server, which writes the extract
   `sofa-T0` from `packages/sofa-domain`. The mock exports `freshWorld` and its constants and only starts its server
   when run directly.
8. **Tests run without Docker:** PGlite (Postgres in WebAssembly) for the event store and a DuckDB-file catalog for
   DuckLake. The Postgres catalog is exercised by the end-to-end check on the stack (`scripts/liquid/e2e-lake.mjs`).

## Consequences

- Deviation from the plan: the flush is a loop in the ontology server, not a Temporal schedule. It moves to a schedule
  in the `business` namespace once the business worker exists (M5).
- DuckLake is not Iceberg. Its data files are Parquet and Iceberg-compatible, and DuckDB can copy a DuckLake to Iceberg
  without rewriting data; if an Iceberg consumer appears, that copy is the path. Engines without DuckLake support can
  read the Parquet files directly.
- Only one ontology server instance may flush (process mutex). High availability is out of scope (plan §1.4); a
  Postgres advisory lock is the step if a second instance is ever added.
- Agents never get credentials for the database or the lake; they will reach business data only through ontology tools
  at the gateway (M3).
