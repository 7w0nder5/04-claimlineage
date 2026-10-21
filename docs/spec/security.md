# Security contract

## Network capture

- Only explicit `http:` and `https:` URLs are accepted.
- Credentials in URLs are rejected.
- Loopback, private, link-local, documentation, multicast, and reserved IP ranges are rejected for IPv4 and IPv6.
- Every redirect is resolved and checked again, with at most five redirects.
- An HTTPS capture cannot redirect to HTTP.
- DNS is resolved before the request and the approved public address is pinned for the connection.
- Requests send no cookies, authorization headers, or referrer.
- Non-identity content encoding is rejected.
- Headers, time, response bytes, URL length, quote length, and bundle size are bounded.

## Local web application

- The server listens on `127.0.0.1` only.
- Every API request requires an unguessable per-process token.
- Mutations require JSON or a bounded binary upload; HTML forms cannot trigger them.
- CORS is not enabled.
- Captured content is displayed only through text nodes.
- A restrictive Content Security Policy blocks external connections and active embedded content.

## Filesystem

- Workspace storage uses fixed internal filenames.
- Symbolic links inside the managed data directory are rejected.
- Existing workspaces and import destinations are never overwritten.
- Object bytes are verified before reuse and during every workspace or bundle verification.
