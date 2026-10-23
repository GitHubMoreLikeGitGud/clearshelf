# ClearShelf

Allergen clearance and recall watch for online grocers. Every decision is cited and every release is signed.

Open Agent Hackathon 2026, Track 3: Reasoning Architecture.

**Status:** repository scaffold. Setup, usage, architecture and evaluation sections are added as the components land.

## Security notes (demo scope)

- **The officer is a local demo identity.** `POST /api/approvals/sign` issues an officer-approved contract to any request on this machine that names the server as its Host and carries no foreign `Origin` (the DNS-rebinding and cross-site checks). There is no login, so a local process without an `Origin` header can sign. A real deployment needs single sign-on in front of the officer endpoints.
- **Execution contracts are an integrity check.** They are HMAC-signed and single-use, as in Scout's own documentation, not cryptographic-grade security. CLEAR, CLEAR_WITH_STATEMENT and RELEASE need an officer approval; a contract signed before a later HOLD or BLOCK is refused.

## Licence

Apache-2.0, see `LICENSE` and `NOTICE`. The vendored Meterless engines are described in `engines/UPSTREAM.md`.
