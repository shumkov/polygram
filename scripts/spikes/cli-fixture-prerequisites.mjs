import fs from 'node:fs';
import path from 'node:path';

function assertFixtureCwd({ cwd, fixtureRoot }) {
  const root = fs.realpathSync(fixtureRoot);
  const realCwd = fs.realpathSync(cwd);
  if (!path.isAbsolute(cwd) || realCwd !== cwd || !realCwd.startsWith(`${root}${path.sep}`)) {
    throw new Error('consent cwd must be canonical and strictly inside the fixture root');
  }
}

// Consent belongs to the disposable project's included local settings, never
// the operator's user settings (which isolated CLI launches deliberately omit).
export function writeFixtureConsent({ cwd, fixtureRoot }) {
  assertFixtureCwd({ cwd, fixtureRoot });
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

// Provide a fixed instruction input without importing the operator's memory.
export function writeFixtureInstructions({ cwd, fixtureRoot }) {
  assertFixtureCwd({ cwd, fixtureRoot });
  const instructionsPath = path.join(cwd, 'CLAUDE.md');
  fs.writeFileSync(instructionsPath, 'This is a synthetic compatibility fixture.\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return instructionsPath;
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

// Local stub mode can retain native auth for Channels without redirecting any
// credential-backed model request outside the disposable fixture.
export function localStubAuthLines({ nativeAuth = false, home, isolatedHome, model = 'stub' }) {
  if (!nativeAuth) return [
    'unset CLAUDE_CODE_OAUTH_TOKEN',
    'export ANTHROPIC_API_KEY=',
    'export ANTHROPIC_AUTH_TOKEN=stub-token-not-a-secret',
  ];
  if (model !== 'stub') throw new Error('native fixture auth requires stub model routing');
  if (!home || !path.isAbsolute(home) || isolatedHome !== home
      || fs.realpathSync(home) !== home) {
    throw new Error('native fixture auth requires canonical isolated HOME');
  }
  const homeStat = fs.lstatSync(home);
  if (!homeStat.isDirectory() || (homeStat.mode & 0o777) !== 0o700
      || homeStat.uid !== process.getuid()) {
    throw new Error('native fixture HOME must be owned and private');
  }
  const directory = path.join(home, '.claude');
  const credential = path.join(directory, '.credentials.json');
  let directoryStat; let credentialStat;
  try {
    directoryStat = fs.lstatSync(directory);
    credentialStat = fs.lstatSync(credential);
  } catch {
    throw new Error('native fixture credential must already exist');
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || (directoryStat.mode & 0o777) !== 0o700 || directoryStat.uid !== process.getuid()
      || !credentialStat.isFile() || credentialStat.isSymbolicLink()
      || (credentialStat.mode & 0o777) !== 0o600 || credentialStat.uid !== process.getuid()
      || fs.realpathSync(credential) !== credential) {
    throw new Error('native fixture credential must be owned, private and contained in HOME');
  }
  return ['unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN'];
}
