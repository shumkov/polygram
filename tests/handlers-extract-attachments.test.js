/**
 * Tests for lib/handlers/extract-attachments.js — pure attachment
 * row builder from Telegram message payloads.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAttachments,
  shortFileTag,
} = require('../lib/handlers/extract-attachments');

describe('shortFileTag', () => {
  test('strips non-alphanumerics + truncates to 8 chars', () => {
    assert.equal(shortFileTag('abc/def#XYZ12345xxxx', 999), 'abcdefXY');
  });

  test('only allowed chars [A-Za-z0-9_-] survive', () => {
    assert.equal(shortFileTag('A_b-C.D!E', 0), 'A_b-CDE');
  });

  test('null / empty file_unique_id falls back to fallback string', () => {
    assert.equal(shortFileTag(null, 42), '42');
    assert.equal(shortFileTag('', 'fb'), 'fb');
    assert.equal(shortFileTag(undefined, 7), '7');
  });

  test('all-stripped id falls back to fallback (does not return empty)', () => {
    assert.equal(shortFileTag('!@#$%', 'fb'), 'fb');
  });

  test('exact-8-char id passes through unchanged', () => {
    assert.equal(shortFileTag('AbCd1234', 0), 'AbCd1234');
  });
});

describe('extractAttachments — early return for media-group bundles', () => {
  test('msg._mergedAttachments returned verbatim', () => {
    const merged = [{ kind: 'photo', name: 'a.jpg' }];
    const out = extractAttachments({ _mergedAttachments: merged });
    assert.equal(out, merged, 'returns the same array reference (no copy)');
  });
});

describe('extractAttachments — per-field extractors', () => {
  test('document: file_name preserved, default mime fallback', () => {
    const out = extractAttachments({
      message_id: 1,
      document: {
        file_id: 'F1', file_unique_id: 'U1',
        file_name: 'report.pdf', file_size: 4096,
      },
    });
    assert.deepEqual(out, [{
      file_id: 'F1', file_unique_id: 'U1',
      name: 'report.pdf',
      mime_type: 'application/octet-stream',
      size: 4096,
      kind: 'document',
    }]);
  });

  test('document with custom mime_type passes through', () => {
    const out = extractAttachments({
      message_id: 1,
      document: { file_id: 'F', mime_type: 'application/pdf', file_name: 'x.pdf' },
    });
    assert.equal(out[0].mime_type, 'application/pdf');
  });

  test('document without file_name auto-names with shortFileTag', () => {
    const out = extractAttachments({
      message_id: 42,
      document: { file_id: 'F', file_unique_id: 'AbCd1234zzzzz' },
    });
    assert.match(out[0].name, /^document-AbCd1234$/);
  });

  test('document without file_unique_id falls back to msg.message_id', () => {
    const out = extractAttachments({
      message_id: 99,
      document: { file_id: 'F' },
    });
    assert.equal(out[0].name, 'document-99');
  });

  test('photo: takes the LARGEST size variant (last array element)', () => {
    const out = extractAttachments({
      message_id: 5,
      photo: [
        { file_id: 'thumb', file_unique_id: 'thumb-uniq', file_size: 100 },
        { file_id: 'med',   file_unique_id: 'med-uniq',   file_size: 1000 },
        { file_id: 'large', file_unique_id: 'large-uniq', file_size: 10000 },
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].file_id, 'large');
    assert.equal(out[0].size, 10000);
    assert.equal(out[0].kind, 'photo');
    assert.equal(out[0].mime_type, 'image/jpeg');
    assert.match(out[0].name, /^photo-large-un.*\.jpg$/);
  });

  test('empty photo array → no photo entry', () => {
    const out = extractAttachments({ message_id: 1, photo: [] });
    assert.equal(out.length, 0);
  });

  test('voice: default mime audio/ogg, .ogg extension', () => {
    const out = extractAttachments({
      message_id: 1,
      voice: { file_id: 'V', file_unique_id: 'voice-uniq', file_size: 5000 },
    });
    assert.equal(out[0].kind, 'voice');
    assert.equal(out[0].mime_type, 'audio/ogg');
    assert.match(out[0].name, /\.ogg$/);
  });

  test('audio: file_name preserved, .mp3 fallback otherwise', () => {
    const out1 = extractAttachments({
      message_id: 1,
      audio: { file_id: 'A', file_name: 'song.flac', mime_type: 'audio/flac' },
    });
    assert.equal(out1[0].name, 'song.flac');
    assert.equal(out1[0].mime_type, 'audio/flac');

    const out2 = extractAttachments({
      message_id: 2,
      audio: { file_id: 'A', file_unique_id: 'aa' },
    });
    assert.match(out2[0].name, /\.mp3$/);
    assert.equal(out2[0].mime_type, 'audio/mpeg');
  });

  test('video: file_name preserved, .mp4 fallback otherwise', () => {
    const out1 = extractAttachments({
      message_id: 1,
      video: { file_id: 'V', file_name: 'movie.mov', mime_type: 'video/quicktime' },
    });
    assert.equal(out1[0].name, 'movie.mov');

    const out2 = extractAttachments({
      message_id: 2,
      video: { file_id: 'V', file_unique_id: 'vv' },
    });
    assert.match(out2[0].name, /\.mp4$/);
    assert.equal(out2[0].mime_type, 'video/mp4');
  });

  test('multi-attachment message (document + photo) extracts both', () => {
    const out = extractAttachments({
      message_id: 1,
      document: { file_id: 'D', file_name: 'a.pdf' },
      photo: [{ file_id: 'P', file_unique_id: 'pp' }],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'document');
    assert.equal(out[1].kind, 'photo');
  });

  test('message with no attachments → empty array', () => {
    assert.deepEqual(extractAttachments({ message_id: 1, text: 'hi' }), []);
  });
});
