# 0008. Swap Pass Order — Observability (Pass 5) Before Security (Pass 6)

* **Status:** Accepted
* **Date:** 2026-08-01 (estimated)
* **Deciders:** <!-- @github-handle -->

## Context
<!-- TODO: Original design had Security before Observability. Security agents then could not see log statements, so they could not detect PII leakage in error logs — a critical blind spot. -->

## Decision
<!-- TODO: New order: Pass 5 = Observability & Error Handling (adds try/catch, logger.error calls), Pass 6 = Security Hardening (reviews all code INCLUDING the log statements for PII leakage, missing sanitisation, OWASP issues). Security now has full visibility of the complete output. -->

## Consequences
### Positive
* <!-- TODO: Security agent can catch raw PII in logger.error() calls that Observability introduced. -->

### Negative / Trade-offs
* <!-- TODO: Security pass now sees a larger context (more files changed). -->
