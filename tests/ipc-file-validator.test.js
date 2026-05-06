/**
 * Tests for lib/ipc-file-validator.js (rc.58).
 *
 * Discovery context: 2026-05-05 incident. Agent generated an Artisan
 * invoice .docx, called polygram-ipc with
 *   document: 'http://localhost::PORT/file.docx'
 * Telegram rejected "Wrong port number specified" — opaque error.
 * The validator catches this class of mistake at the IPC boundary
 * with a clear remediation message.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateIpcFileParam } = require('../lib/ipc/file-validator');

describe('validateIpcFileParam — accepts good shapes', () => {
  test('null when method has no file param (sendMessage)', () => {
    assert.equal(validateIpcFileParam('sendMessage', { text: 'hi' }), null);
  });

  test('null when document is omitted', () => {
    assert.equal(validateIpcFileParam('sendDocument', { chat_id: '1' }), null);
  });

  test('null when document is { source } envelope (preferred)', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: { source: '/abs/path/x.pdf' },
    });
    assert.equal(r, null);
  });

  test('null when document is a public HTTPS URL', () => {
    assert.equal(
      validateIpcFileParam('sendDocument', { document: 'https://cdn.example.com/x.pdf' }),
      null,
    );
  });

  test('null when document is a Telegram file_id (no scheme, no slash)', () => {
    assert.equal(
      validateIpcFileParam('sendDocument', { document: 'BAADAQADwAADBREAAVoQOnEZmRRJpmcE' }),
      null,
    );
  });

  test('null when document is a Buffer/Stream (grammy InputFile shape)', () => {
    assert.equal(
      validateIpcFileParam('sendDocument', { document: Buffer.from([1, 2, 3]) }),
      null,
    );
  });

  test('photo with HTTPS URL is fine', () => {
    assert.equal(
      validateIpcFileParam('sendPhoto', { photo: 'https://cdn.example.com/x.jpg' }),
      null,
    );
  });
});

describe('validateIpcFileParam — rejects bad shapes', () => {
  test('rejects http:// localhost URL — the actual incident', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: 'http://localhost:8080/invoice.docx',
    });
    assert.match(r, /localhost URLs unreachable/);
  });

  test('rejects 127.0.0.1 URL', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: 'http://127.0.0.1:3000/x.pdf',
    });
    assert.match(r, /localhost URLs unreachable/);
  });

  test('rejects 0.0.0.0 URL', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: 'http://0.0.0.0:9000/x.pdf',
    });
    assert.match(r, /localhost URLs unreachable/);
  });

  test('rejects [::1] (IPv6 localhost) URL', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: 'http://[::1]:8080/x.pdf',
    });
    assert.match(r, /localhost URLs unreachable/);
  });

  test('rejects HTTPS localhost URL too', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: 'https://localhost:8443/x.pdf',
    });
    assert.match(r, /localhost URLs unreachable/);
  });

  test('rejects http:// public URL (not HTTPS)', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: 'http://cdn.example.com/x.pdf',
    });
    assert.match(r, /only HTTPS URLs supported/);
  });

  test('rejects ftp:// URL', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: 'ftp://files.example.com/x.pdf',
    });
    assert.match(r, /only HTTPS URLs supported/);
  });

  test('rejects bare absolute path string', () => {
    const r = validateIpcFileParam('sendDocument', {
      document: '/Users/shumabit/work/invoice.docx',
    });
    assert.match(r, /bare file path not accepted/);
    // Verify the remediation hint includes the wrapping shape:
    assert.match(r, /\{ source: '\/Users\/shumabit\/work\/invoice\.docx' \}/);
  });

  test('rejects empty string', () => {
    const r = validateIpcFileParam('sendDocument', { document: '' });
    assert.match(r, /document is empty/);
  });

  test('error message names the right param for sendPhoto', () => {
    const r = validateIpcFileParam('sendPhoto', {
      photo: 'http://localhost:8000/img.png',
    });
    assert.match(r, /localhost URLs/);
  });
});

describe('validateIpcFileParam — file-bearing methods coverage', () => {
  test('covers sendDocument, sendPhoto, sendAudio, sendAnimation, sendVideo, sendVoice', () => {
    for (const method of ['sendDocument', 'sendPhoto', 'sendAudio', 'sendAnimation', 'sendVideo', 'sendVoice']) {
      const param = method.slice(4).toLowerCase(); // 'sendDocument' → 'document'
      // Bad localhost URL — should be rejected for every file-bearing method
      const r = validateIpcFileParam(method, { [param]: 'http://localhost:1/x' });
      assert.match(r, /localhost URLs/, `expected localhost rejection for ${method}`);
    }
  });

  test('non-file methods (sendMessage, sendChatAction, etc.) are pass-through', () => {
    for (const method of ['sendMessage', 'sendChatAction', 'sendSticker', 'editMessageText', 'setMessageReaction']) {
      assert.equal(validateIpcFileParam(method, { text: 'http://localhost:8080/x' }), null,
        `${method} should not validate file params`);
    }
  });
});
