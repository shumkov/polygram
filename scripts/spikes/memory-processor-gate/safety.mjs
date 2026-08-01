import crypto from 'node:crypto';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sentinelCore(value) {
  const alphanumeric = String(value).replace(/[^A-Za-z0-9]/g, '');
  if (alphanumeric.length < 12) return alphanumeric;
  return alphanumeric.slice(-16);
}

function surfaceText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return JSON.stringify(value);
}

export function createSecretInventory(sentinels) {
  return sentinels.map((sentinel) => ({
    id: sentinel.id,
    tier: sentinel.tier,
    length: sentinel.value.length,
    sha256: sha256(sentinel.value),
    coreSha256: sha256(sentinelCore(sentinel.value)),
  }));
}

export function scanSurfaces({ sentinels, surfaces }) {
  const hits = [];
  const scannedSurfaces = [];
  const byteCounts = {};

  for (const [surface, value] of Object.entries(surfaces)) {
    const serialized = surfaceText(value);
    scannedSurfaces.push(surface);
    byteCounts[surface] = Buffer.byteLength(serialized);
    for (const sentinel of sentinels) {
      const core = sentinelCore(sentinel.value);
      if (serialized.includes(sentinel.value) || (core.length >= 12 && serialized.includes(core))) {
        hits.push({
          surface,
          sentinelId: sentinel.id,
          sentinelSha256: sha256(sentinel.value),
        });
      }
    }
  }

  return {
    hitCount: hits.length,
    hits,
    scannedSurfaces,
    byteCounts,
  };
}
