import fs from 'node:fs';
import path from 'node:path';

// Consent belongs to the disposable project's included local settings, never
// the operator's user settings (which isolated CLI launches deliberately omit).
export function writeFixtureConsent({ cwd, fixtureRoot }) {
  const root = fs.realpathSync(fixtureRoot);
  const realCwd = fs.realpathSync(cwd);
  if (!path.isAbsolute(cwd) || realCwd !== cwd || !realCwd.startsWith(`${root}${path.sep}`)) {
    throw new Error('consent cwd must be canonical and strictly inside the fixture root');
  }
  const directory = path.join(cwd, '.claude');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('fixture settings directory must not be a symlink');
  }
  const settingsPath = path.join(directory, 'settings.local.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ skipDangerousModePermissionPrompt: true }), {
    mode: 0o600,
    flag: 'wx',
  });
  return settingsPath;
}

// A missing known rejection is not evidence of enrollment. Actual channel
// delivery remains the driver's oracle after this negative-only preflight.
export function rejectUnavailableChannels(pane) {
  if (/channels (?:are not (?:currently available|available on third-party providers)|not enabled by org policy|blocked by org policy)/i.test(pane)) {
    const error = new Error('Channels prerequisite unavailable; use an authorized Anthropic account with Channels enabled');
    error.code = 'CHANNELS_FIXTURE_UNAVAILABLE';
    throw error;
  }
}
