# Local Qwen gate runner

These modules are an offline, disposable Linux gate design. They do not start
Docker, pull an image, download a model, change production configuration, or
write evidence to disk. The dependency-injected runner is a test core only and
can never produce admissible G3 evidence. The production entry point currently
fails closed until a sealed live collector binds Docker inspection, model
identity, cgroup counters, and Unix-socket traffic to one stable container PID.

## API

- `attestation.mjs`
  - `inspectModelFile(absolutePath)` streams the model once and returns only its
    byte count and SHA-256.
  - `attestModelArtifact(observed, runtime?)` compares those values with the
    pinned `LLAMA_RUNTIME` values.
  - `attestDockerRuntime({ imageInspect, containerInspect, expectedContainer,
    runtime? })` is a pure validator for the pinned Linux/amd64 image digest and
    exact image entrypoint, image-default environment, and launch configuration.
    It requires no network, read-only root,
    `CapDrop=ALL`, no added capabilities, no-new-privileges, non-root user,
    built-in seccomp, exact CPU/PID/memory/no-swap limits, no ports/devices,
    disabled core dumps, a bounded no-exec tmpfs, auto-removal, and exactly one
    read-only model bind plus one writable socket-directory bind. The server
    command must exactly equal the code-pinned `LLAMA_SERVER_COMMAND`; every
    unapproved mount is rejected, including non-bind volumes. The non-root user,
    working directory, and host mount sources come from `expectedContainer`,
    while entrypoint and environment are independently bound to the verified
    image defaults. Any inspection drift fails closed. Returned
    evidence contains hashes and pinned identifiers, not host paths.
- `token-budget.mjs`
  - `buildApplyTemplateRequest`, `parseAppliedTemplate`,
    `buildTokenizeRequest`, `parseTokenCount`, and `assertTokenBudget` are small
    independently testable helpers.
  - `preflightTokenBudget` calls only `/apply-template` and `/tokenize` and
    rejects unless `input_tokens + 2048 <= 8192`. The completion's reported
    prompt-token count must then exactly match the preflight count.
- `uds-client.mjs`
  - `createUnixJsonTransport({ socketPath })` uses Node's `socketPath` HTTP
    option and permits only `/apply-template`, `/tokenize`, and
    `/v1/chat/completions`. It has no TCP/URL option and bounds responses at
    4 MiB.
- `resources.mjs`
  - `createCgroupV2Sampler(absoluteCgroupPath)` reads `memory.peak`,
    `memory.swap.current`, `memory.events`, and `cpu.stat`.
  - `summarizeResourceWindow(before, after, runtime?)` rejects counter resets
    and fails the resource gate on excess memory, any swap, or any OOM event.
- `runner.mjs`
  - `runLocalGateTestCore(options)` exercises model, Docker, schema, resource,
    deadline, and three-run logic with injected dependencies. Its result always
    has `admissible:false` and `passed:false`, even if `evaluationPassed` is true.
  - `runBoundedLocalGate()` currently throws
    `LOCAL_RUNTIME_SEALED_COLLECTOR_REQUIRED`. It must not be enabled until the
    collector verifies a stable container ID/PID/start time, that PID's cgroup-v2
    identity and limits/counters, and the container-visible model inode/content
    identity throughout all three runs.
  - `summarizeJobMetrics(jobs, elapsedMs)` and `summarizeGateRuns(runs)` are pure
    helpers for focused tests. The latter reports both the overall result and a
    deterministic worst run.

Test-core option shape (never admissible evidence):

```js
import { LLAMA_SERVER_COMMAND } from '../adapters/llama.mjs';

await runLocalGateTestCore({
  fixtures,
  modelPath: '/approved/model/Qwen3-4B-Q4_K_M.gguf',
  imageInspect,       // already-collected `docker image inspect` object
  containerInspect,   // already-collected `docker inspect` object
  expectedContainer: {
    command: [...LLAMA_SERVER_COMMAND],
    environment: ['<exact pinned Docker Config.Env entries>'],
    user: '65532:65532',
    workingDirectory: '',
    mounts: [
      {
        source: '/approved/model/Qwen3-4B-Q4_K_M.gguf',
        destination: '/models/Qwen3-4B-Q4_K_M.gguf',
        readWrite: false,
      },
      {
        source: '/approved/private-socket-directory',
        destination: '/run/llama',
        readWrite: true,
      },
    ],
  },
  hostSocketPath: '/approved/private-socket-directory/extractor.sock',
  resourceSampler: createCgroupV2Sampler('/sys/fs/cgroup/<exact-container-cgroup>'),
});
```

The result is text-free with respect to model input/output: it contains fixture
IDs and fixed processor/runtime identifiers, hashes, pass/fail codes, scores,
latencies, token counts, and resource counters. It does not contain prompts,
applied templates, candidate facts, response text, filesystem paths, Docker
environment values, or exception messages. Callers must apply the same rule if
they serialize thrown errors: persist `error.code`, never `error.message` or a
stack trace.

## Admissibility blocker

Caller-supplied inspection JSON, cgroup paths, samplers, transports, and model
readers are deliberately insufficient evidence: a fake or mismatched dependency
could otherwise describe a hardened container while scoring a different
process. The sealed collector is not implemented. No local model result may be
recorded as a G3 pass until that binding exists and receives another review.

## Other limitations

- These modules deliberately do not define or execute the Docker launch
  command. The operator must preregister one exact argv/environment manifest;
  attestation proves that the live container matches it.
- The test core validates Docker inspection documents but does not establish
  that they came from the process serving the supplied Unix socket.
- The cgroup path must identify only the disposable model container. A parent
  or reused cgroup makes resource evidence invalid.
- The server must implement llama.cpp's `/apply-template`, `/tokenize`, and
  OpenAI-compatible chat-completion endpoints on the private Unix socket.
- Equality between preflight and completion prompt-token counts is intentional.
  An upstream template/tokenization semantic change fails closed and requires a
  reviewed adapter update; the runner never estimates tokens from characters.
- Passing this runner establishes only the preregistered corpus/runtime gate.
  It does not approve a processor for production, replace the separate G1/G2/
  G4-G6 gates, or prove behavior outside the fixture corpus.
