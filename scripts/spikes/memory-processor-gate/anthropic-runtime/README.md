# Anthropic direct-runtime gate

This runner performs the approved G3 comparison through Anthropic's synchronous
`POST /v1/messages` endpoint. It never uses Message Batches. Importing the
modules performs no network or credential access.

An actual run requires all three arguments and a commercial API key:

```sh
ANTHROPIC_API_KEY=... node scripts/spikes/memory-processor-gate/anthropic-runtime/run.mjs \
  --approve-synthetic-egress \
  --retention-mode standard \
  --output /absolute/private/path/anthropic-g3.json
```

Use `--retention-mode zdr-verified` only after verifying ZDR on the exact
Anthropic organization used by the key. The output path must not exist. The
runner creates it mode `0600` and persists structural evidence only.

The runner first sends one all-tier-sanitized synthetic shape-check fixture,
then runs all 200 locked fixtures three complete times. Each request attempt is
limited to 10 seconds and every attempt plus retry wait shares one hard
60-second job deadline. At most two explicit retries are permitted, only for a
connection failure or HTTP 408, 409, 429, 500, 504, or 529; `retry-after` is
honored only while it fits inside the remaining job deadline, otherwise the
request fails. Retries without `retry-after` use exponential backoff with
bounded jitter. Redirects are rejected so the API key and body cannot leave the
pinned endpoint. Requests force Anthropic's `standard_only` service tier so the
recorded direct pricing remains applicable.

Cost is calculated exactly from returned input/output usage at the documented
Haiku 4.5 direct rates ($1/$5 per million tokens). If a request retries, fails
without usage, or reports prompt-cache token classes, total billing cannot be
proven from the response alone. The evidence labels cost non-exact and the gate
does not pass. This is deliberate: a timed-out request may have completed and
been billed even though the client received no usage record.

The first-party API is globally routed by default; Haiku 4.5 does not accept a
per-request `inference_geo`. Standard commercial retention deletes API inputs
and outputs within 30 days subject to documented exceptions. Under a verified
ZDR arrangement, prompts and responses are not retained at rest after the
response, while the data-free structured-output schema grammar may be cached
for up to 24 hours. Automated safety flags and legal obligations can require
longer retention under either arrangement.
