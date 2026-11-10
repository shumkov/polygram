/**
 * Voice attachment transcription handler.
 *
 * Per-message Telegram voice/audio attachments get transcribed via
 * the configured provider (OpenAI Whisper today). The transcript is
 * persisted both per-attachment (JSON in attachments.transcription)
 * AND combined into messages.text so chat-search picks up "what
 * Maria said" via the normal text path.
 *
 * Also fires a one-time 👂 reaction so the user knows the voice was
 * heard before transcription completes; the caller is told to
 * suppress the QUEUED 👀 (otherwise both flash visibly).
 *
 * Factory pattern: polygram.js wires the runtime deps (config, db,
 * dbWrite, tg, logEvent, transcribeVoice impl, isVoiceAttachment)
 * once and the returned function does the per-call work.
 */

'use strict';

// The reason a failed transcription is reported under, both to the agent
// (<voice-transcription-failed reason=…>) and as the event's error_code. A
// closed set, so neither can carry an errno, a path or provider text.
const FAILURE_CODES = new Set([
  'not-configured', 'too-large', 'timeout', 'quota-exhausted',
  'network', 'bad-response', 'empty',
]);

function failureCode(err) {
  const code = err?.code;
  if (FAILURE_CODES.has(code) || /^http-\d{3}$/.test(code)) return code;
  return 'unknown';
}

function createTranscribeVoiceAttachments({
  config,
  db,
  dbWrite,
  tg,
  logEvent,
  transcribeVoice,
  isVoiceAttachment,
  botName,
  logger = console,
} = {}) {

  return async function transcribeVoiceAttachments(downloaded, { chatId, msgId, label, botApi /* , threadId */ }) {
    const voiceCfg = config.bot?.voice || config.voice;
    if (!voiceCfg?.enabled) return { ackEmitted: false };
    const provider = voiceCfg.provider || 'openai';
    const providerCfg = voiceCfg[provider] || {};
    const targets = downloaded.filter((a) => isVoiceAttachment(a) && a.path);
    if (!targets.length) return { ackEmitted: false };

    // Acknowledge receipt with a reaction so the user knows we heard
    // them. Cheap, robust (no state), and survives transcription
    // failure. ackEmitted=true tells the caller to skip the reactor's
    // QUEUED → 👀 transition (otherwise 👂 + 👀 flash visibly).
    const ack = voiceCfg.ackReaction || '👂';
    let ackEmitted = false;
    if (ack && botApi) {
      ackEmitted = true;
      tg(botApi, 'setMessageReaction', {
        chat_id: chatId, message_id: msgId,
        reaction: [{ type: 'emoji', emoji: ack }],
      }, { source: 'voice-ack', botName }).catch((err) => {
        logger.error?.(`[${label}] voice ack reaction failed: ${err.message}`);
      });
    }

    // A transcript stored on an earlier attempt (boot replay, redelivery,
    // startup retry all re-read the attachment row) is reused rather than
    // paid for again.
    const pending = targets.filter((a) => !a.transcription?.text);
    await Promise.all(pending.map(async (a) => {
      try {
        const opts = {
          provider,
          ...providerCfg,
          language: voiceCfg.language || 'auto',
          maxDurationSec: voiceCfg.maxDurationSec,
          maxDurationBytesPerSec: voiceCfg.maxDurationBytesPerSec,
          maxFileBytes: voiceCfg.maxFileBytes,
          timeoutMs: voiceCfg.timeoutMs,
        };
        const r = await transcribeVoice(a.path, opts);
        a.transcription = r;
        logger.log?.(`[${label}] transcribed ${a.kind} (${r.duration_sec?.toFixed?.(1) || '?'}s, ${r.text.length} chars)`);
        logEvent('voice-transcribed', {
          chat_id: chatId, msg_id: msgId,
          provider: r.provider, language: r.language,
          duration_sec: r.duration_sec, chars: r.text.length,
          cost_usd: r.cost_usd,
        });
      } catch (err) {
        const code = failureCode(err);
        a.transcriptionError = code;
        logger.error?.(`[${label}] transcribe failed for ${a.name}: ${err.message}`);
        logEvent('voice-transcribe-failed', {
          chat_id: chatId, msg_id: msgId, error_class: err.name || 'Error',
          error_code: code,
        });
      }
    }));

    // Persist transcription:
    //   - Per-attachment: setAttachmentTranscription stores the
    //     full object (text + language + duration + provider) as
    //     JSON in attachments.transcription. buildVoiceTags
    //     parses it back when building the prompt.
    //   - Message-level: setMessageText updates messages.text with
    //     the combined transcript so FTS finds "what Maria said"
    //     via the normal chat search path.
    const successful = pending.filter((a) => a.transcription?.text);
    if (!successful.length) return { ackEmitted };
    for (const a of successful) {
      if (a.id != null) {
        dbWrite(() => db.setAttachmentTranscription(a.id, JSON.stringify(a.transcription)),
          `setAttachmentTranscription ${a.id}`);
      }
    }
    // Combine every transcript of the message, reused ones included, so a
    // partially replayed album still stores its full text.
    const combinedText = targets.filter((a) => a.transcription?.text)
      .map((a) => a.transcription.text).join(' ').trim();
    dbWrite(() => db.setMessageText({
      chat_id: chatId, msg_id: msgId, text: combinedText,
    }), 'persist voice transcription');
    return { ackEmitted };
  };
}

module.exports = { createTranscribeVoiceAttachments };
