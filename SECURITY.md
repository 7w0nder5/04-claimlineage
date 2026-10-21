# Security policy

## Supported versions

Security fixes are provided for the latest released minor version.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting. Do not include live credentials, private evidence bundles, or unredacted source material in an issue.

## Trust boundary

ClaimLineage proves that stored bytes still match a recorded SHA-256 digest. It does not prove that a source is authentic or that a claim is true. Captured content remains untrusted input and is never executed by the application.

The local web interface binds to a loopback address, requires a random session token for every API request, rejects cross-origin API access, and accepts mutating requests only as JSON or bounded binary uploads.
