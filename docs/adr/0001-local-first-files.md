# ADR 0001: Local-first, dependency-free evidence storage

Status: accepted on 2026-10-21.

## Decision

Version 0.1 uses Node.js standard-library modules, canonical JSON metadata, and a content-addressed object directory. It does not require a database, cloud account, package installation, or background service.

## Why

The first release needs a portable and auditable data contract more than query scale. Plain files make recovery, review, fixtures, and offline bundle verification straightforward. Atomic metadata replacement and immutable object bytes provide the required safety without introducing native database compatibility failures.

## Upgrade condition

A database is justified only when measured workspace size or query latency exceeds the documented limits. Any future storage engine must import schema version `1` fixtures and preserve deterministic bundle semantics.
