# Product contract

## Problem

A URL in a note or report does not preserve the exact bytes that supported a conclusion. The target can change, disappear, or become ambiguous, while the written claim remains unchanged.

ClaimLineage keeps a local, inspectable relationship between:

1. a human-authored claim;
2. an exact text quote;
3. an immutable source snapshot;
4. capture metadata and a SHA-256 digest; and
5. a deterministic bundle that another machine can verify offline.

## Version 0.1 user journey

1. Initialize a workspace.
2. Import a local file, upload a file in the local web interface, or explicitly capture one HTTP/HTTPS URL.
3. Add a claim and select one exact, unambiguous quote from a snapshot.
4. Verify the workspace at any time.
5. Check whether an original source now differs without replacing the saved snapshot.
6. Export a `.clb` evidence bundle and verify or import it offline.

## Non-goals

Version 0.1 does not provide cloud sync, accounts, collaboration, OCR, browser extensions, automated truth judgments, crawling, PDF coordinate selectors, digital signatures, or blockchain storage.

## Product language

The application may say that content is intact, changed, unavailable, or invalid. It must not say that a source is genuine or that a claim is true merely because a digest matches.
