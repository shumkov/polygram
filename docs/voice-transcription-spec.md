# Voice transcription in production — spec

## Problem

Polygram already has a complete voice pipeline:
1. download the Telegram voice or audio file;
2. transcribe it (`lib/telegram/voice.js`);
3. store the text in `attachments.transcription` and `messages.text`;
4. give it to the agent as a `<voice>` tag (`lib/prompt.js`).

No bot has it enabled, and the backends no longer fit. On the UMI VPS, the
`shumabit` bot (@shumobot) has received 13 voice notes since April. They came
from four chats, in Russian, English and Thai, and every time the agent replied
that it cannot listen to voice messages. Ivan wants to send it voice notes.

## Measurements that chose the engine

All runs were on the VPS under its normal load. The host is an 8 vCPU AMD EPYC
with AVX2 and no GPU. CPU pressure averaged about 40% over 300 s, from memsearch
indexing, Chatwoot and Photoroom. The clips were synthetic Telegram-style
ogg/opus files:
- 22 s of Russian with English product names;
- 11 s of English;
- 10 s of Thai.

| Engine | 22 s RU | 11 s EN | 10 s TH | Quality |
|---|---|---|---|---|
| faster-whisper large-v3-turbo int8 | 59–88 s | 69–90 s | 71 s | Best of the local engines: RU and EN terms correct, Thai good |
| faster-whisper small int8 | 25 s | 12 s | 18 s | RU terms mangled ("Shopify" → "OP-FI") |
| Parakeet TDT 0.6B v3 int8 (sherpa-onnx, the model Orca uses) | 5.6 s | 2.9 s | 2.4 s | RU usable, EN terms mangled, **Thai unusable** (Thai is not supported) |

Loading the model added another 9–20 s per process. Turbo was the only local
model good enough, and it ran 3–8× slower than real time on this host while
competing with the Claude sessions for CPU. Ivan chose the OpenAI API
(2026-11-10).

## Chosen approach

Use the existing `openai` provider with **`gpt-transcribe`**, OpenAI's current
recommended transcription model.
- **Price and billing:** $0.0045 per minute, billed by duration.
- **Older models avoided:** `whisper-1`, `gpt-4o-transcribe` and
  `gpt-4o-mini-transcribe` shut down on 2027-02-26.
- **Endpoint:** `POST /v1/audio/transcriptions`. It accepts flac, mp3, mp4,
  mpeg, mpga, m4a, ogg, wav and webm, up to 25 MB per file. Telegram voice
  notes are ogg, so no ffmpeg is needed.

### Code changes

1. **`apiKeyFile`** (`voice.openai.apiKeyFile`).
   - The key is read on each call and trimmed. It must then match
     `/^[\x21-\x7E]+$/` (one printable token).
   - A missing, unreadable or invalid file throws `not-configured`, and the key
     never appears in the message. undici echoes an invalid header value in its
     error, so validating first keeps the key out of the logs.
   - When `apiKeyFile` is set, there is **no fallback** to `apiKeyEnv`.
     Otherwise a stray unrestricted `OPENAI_API_KEY` could be used silently.
   - Why a file: the VPS CLI launcher copies the whole daemon environment into
     every Claude session (`env = dict(os.environ)`), so a key kept in the
     environment would be readable in every agent shell. The SDK backend
     already filters the environment (`lib/sdk/build-options.js`).
   - A file is still readable by the same Unix user, as `config.json` with the
     bot token already is. See stage 2.
2. **`gpt-transcribe` request and response.**
   - **Default model:** `gpt-transcribe`.
   - **Response format:** `response_format` is never sent, so the default
     `json` is used. Explicit `whisper-1` configs then get plain text, which is
     acceptable because the model is going away and no bot uses it.
   - **Language hint:** when a language other than `auto` is configured,
     models whose name starts with `gpt-transcribe` get `languages[]` with the
     two-letter code; other models get `language`. Sending the wrong field, or
     both, is rejected.
   - **Response parsing:**
     - `language` comes from `j.language ?? j.languages?.[0]?.code`.
     - `duration_sec` comes from `j.duration ?? j.usage?.seconds`.
     - `cost_usd` is the duration times 0.0045 per minute. It is omitted when
       the duration is unknown; it is telemetry only, and the OpenAI dashboard
       is the source of truth for spend.
3. **Size cap.**
   - `transcribe()` checks `stat.size` against `opts.maxFileBytes` before it
     reads the key or the file. The default is 25 MB, OpenAI's limit, and an
     oversized file throws `too-large`.
   - Without the cap, the local Bot API server lets shumabit accept files up to
     100 MB. The file would be loaded into memory and fully uploaded, only for
     OpenAI to reject it with 413.
4. **Timeout.**
   - `fetch` gets `signal: AbortSignal.timeout(opts.timeoutMs ?? 120000)`. The
     signal also aborts reading the response body.
   - Both `TimeoutError` and `AbortError` map to `timeout`.
5. **Closed set of failure codes, surfaced to the agent.**
   - `transcribe()` throws errors with a `code`:

     | Code | Cause |
     |---|---|
     | `not-configured` | missing, unreadable or invalid key |
     | `too-large` | file over the size cap |
     | `timeout` | request aborted |
     | `quota-exhausted` | 429 with `error.code === 'insufficient_quota'` |
     | `http-<status>` | any other HTTP error |
     | `network` | fetch `TypeError` with a `cause` |
     | `bad-response` | a 200 whose body is not JSON or has no string `text` |
     | `empty` | a 200 with blank text: silence or music |

   - The handler maps the code through an allowlist, and anything else, such as
     `ENOENT` or a local-provider error, becomes `unknown`.
   - The code goes to `voice-transcribe-failed` as `error_code`, a
     schema-typed, content-free field. It is also set as
     `a.transcriptionError`.
   - `buildVoiceTags` then emits
     `<voice-transcription-failed kind="voice" reason="<code>" />`, following
     the existing `<attachment-failed reason=…>` pattern.
   - Error messages carry the status and OpenAI's `error.code`, never the
     response body.
6. **`<voice>` is untrusted input.** The Security sentence in `polygramInfo`
   (`lib/prompt.js`) gains `<voice>` next to `<untrusted-input>`. A partner can
   now speak instructions to the agent, and that speech must be framed as data.
7. **No second charge for a stored transcript.**
   - A voice attachment whose stored transcription already has text is not sent
     again. Boot replay, drop-redelivery, Codex replay and the startup retry all
     re-read the attachment row, and that row includes `transcription`.
   - The guard is one line.
8. **Boot log.** One line, `voice: <provider>/<model> enabled` (no key path),
   lets the deploy check prove that the running config has voice turned on.

The 👂 acknowledgement, the persistence, the `<voice>` tag and the handling of
`audio`-kind files are unchanged.

### Deferred (not in this change)

- **`keywords[]` vocabulary hints.** We add them only if the real-API smoke
  test shows that proper-noun errors matter. The evidence so far comes from
  local Whisper, and Claude reads the transcript in context anyway.
- **Duration cap from Telegram metadata.** Durations are missing on replay
  paths and for audio albums, and the sender supplies them. The size cap, the
  project budget and the restricted key bound the spend instead.

### Configuration (VPS, `bots.shumabit` only)

```json
"voice": {
  "enabled": true,
  "provider": "openai",
  "openai": { "apiKeyFile": "/home/shumabit/.config/polygram/openai-stt.key" }
}
```

- **What this covers:** the config is bot-wide. Voice notes from every
  shumabit chat, including staff, partners and groups, go to OpenAI, and that
  is intended: those are the people who have been sending voice notes.
- **What stays off:** `umi-assistant` and the local `shumorobot` stay
  disabled.

### Key provisioning

- **The key:** Ivan creates a key in a dedicated OpenAI project.
  - It is restricted to model capabilities with everything else set to None.
    OpenAI groups audio with other model endpoints, so the key cannot be
    audio-only.
  - The project has a budget, and the project is the revocation boundary.
- **Getting it onto the VPS:** the key is piped from the clipboard to the key
  file, which has mode 0600 inside a directory with mode 0700. It is never
  printed or pasted into chat.
- **Follow-up:** moving the canonical copy into Infisical, rendered by
  `shumabit-secrets.service`, belongs to the `umi-vps-infra` owner.

## Alternatives rejected

- **Local engines on the VPS:** see the measurements above.
- **Groq, running the same turbo model in about 1 s:** it needs a new vendor
  account.
- **A generic `command` provider with a Python sidecar:** it is only useful
  for a local engine.
- **Offloading to the Mac (Metal):** the Mac is a laptop, not a dependable
  server.
- **Putting the key in `config.json`:** `saveConfig` rewrites that file and it
  is copied into backups regularly. A dedicated file has one purpose.

## Failure modes

| Failure | Behaviour |
|---|---|
| Key file missing, unreadable, or not one printable token | `not-configured`, with no fallback to the environment; the agent tells the user; event logged |
| Budget cap reached | `quota-exhausted` (distinct from a temporary `http-429`) |
| 401, 429 or 5xx from OpenAI | `http-<status>`; no retry, because a voice note is cheap to resend |
| OpenAI slow or down | aborted at 120 s, including while reading the body; `timeout`; the turn proceeds without a transcript |
| File over 25 MB | `too-large`; nothing is read or sent |
| Audio file with an extension OpenAI does not accept (`.oga`, `.opus`, none) | `http-400`, reported through the tag |
| Silence or music | `empty`; the agent says it heard nothing |
| Replay of an already transcribed voice note | the stored transcript is reused; no second call |
| Deploy restart during an in-flight call | the result is lost; replay calls again (one extra charge) |
| A text sent right after a voice note | may reach the agent first, by up to the transcription time; transcription runs before the per-session lock |

Two existing quirks are out of scope and left unchanged. On replay the
transcript appears in both `<untrusted-input>` (from `messages.text`) and
`<voice>`. The redelivery gate also runs abort detection on that text, so a
spoken "stop" acts as an abort.

## Stage 2 (hardening that does not shape the architecture)

- Agent sessions can read the key file, because they run as the same Unix
  user. The key's restriction and the project budget limit the damage.
- An operator alert on `not-configured`, `http-401` and `quota-exhausted`.
- A daily spend cap per chat or per user, built from the `cost_usd` events.
- Neither `[redact:]` nor the secret sweep covers `attachments.transcription`,
  and the `.ogg` file stays on disk.

## Verification plan

1. **Unit tests, written red-first, one per numbered change:**
   - `apiKeyFile`: precedence, validation and no fallback;
   - the request shape for `gpt-transcribe` versus other models;
   - response parsing;
   - the size cap;
   - the timeout;
   - the error codes and the allowlist;
   - the failure tag;
   - `<voice>` in the security sentence;
   - the skip-on-stored-transcript guard.
2. `npm test` stays green.
3. **Real-API smoke test:** the real `transcribe()` with the real key file, on
   the three synthetic clips (about $0.003). The transcripts must be correct,
   with `language` and `duration_sec` filled in. This decides whether
   `keywords` are needed.
4. **Release and deploy:** release 0.44.0 and deploy it to the VPS. The config
   is edited right before the deploy restart, because `saveConfig` can revert
   a hand edit if a `/config` change lands in between. After the restart, read
   `bots.shumabit.voice` back from disk and check the boot log for the voice
   line.
5. **Live check:** Ivan sends @shumobot a voice note containing a distinctive
   phrase.
   - `voice-transcribed` is logged, with a provider and a duration.
   - `attachments.transcription` and `messages.text` are set.
   - The reply quotes or acts on the phrase.
   - There are zero `voice-transcribe-failed` events since the deploy.

   This also proves that the service can read the key file under its systemd
   user.
