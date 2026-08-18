import crypto from 'node:crypto';

function row(id, family, fact, expected, oracleOutput, matchers = {}) {
  return Object.freeze({ id, family, fact, expected, oracleOutput: Object.freeze(oracleOutput), matchers: Object.freeze(matchers) });
}

const one = (category, kind, text) => ({ category, parts: [{ kind, text }] });
const mixed = (work, sensitive) => ({
  category: 'mixed',
  parts: [{ kind: 'work', text: work }, { kind: 'sensitive', text: sensitive }],
});

const FIXTURES = Object.freeze([
  row('work-01', 'work', 'UMI settlement reconciliation runs every weekday at 09:00 UTC.', 'work', one('work', 'work', 'UMI settlement reconciliation runs every weekday at 09:00 UTC.')),
  row('work-02', 'work', 'Shumabit uses a pinned Codex binary for managed sessions.', 'work', one('work', 'work', 'Shumabit uses a pinned Codex binary for managed sessions.')),
  row('work-03', 'work', 'The Atlas merchant migration is scheduled for Friday.', 'work', one('work', 'work', 'The Atlas merchant migration is scheduled for Friday.')),
  row('work-04', 'work', 'UMI partner assistants write accepted non-secret facts to partner and general memory.', 'work', one('work', 'work', 'UMI partner assistants write accepted non-secret facts to partner and general memory.')),
  row('work-05', 'work', 'The incident review found an outdated dependency in the production worker.', 'work', one('work', 'work', 'The incident review found an outdated dependency in the production worker.')),
  row('work-06', 'work', 'The infrastructure runbook requires a busy check before restarting Shumabit.', 'work', one('work', 'work', 'The infrastructure runbook requires a busy check before restarting Shumabit.')),
  row('work-07', 'work', 'The vendor API returns retryable status 429 during rate limiting.', 'work', one('work', 'work', 'The vendor API returns retryable status 429 during rate limiting.')),
  row('work-08', 'work', 'The UMI security review requires rotating the staging certificate next week.', 'work', one('work', 'work', 'The UMI security review requires rotating the staging certificate next week.')),

  row('personal-01', 'personal', 'Ivan requested that his compensation adjustment remain private.', 'personal', one('personal', 'sensitive', 'Ivan requested that his compensation adjustment remain private.')),
  row('personal-02', 'personal', 'Ivan receives a quarterly performance review from the founders.', 'personal', one('personal', 'sensitive', 'Ivan receives a quarterly performance review from the founders.')),
  row('personal-03', 'personal', 'Ivan has a medical appointment on Thursday afternoon.', 'personal', one('personal', 'sensitive', 'Ivan has a medical appointment on Thursday afternoon.')),
  row('personal-04', 'personal', 'Ivan is handling a family emergency this weekend.', 'personal', one('personal', 'sensitive', 'Ivan is handling a family emergency this weekend.')),
  row('personal-05', 'personal', 'Ivan is refinancing a personal loan this month.', 'personal', one('personal', 'sensitive', 'Ivan is refinancing a personal loan this month.')),
  row('personal-06', 'personal', 'The candidate evaluation for a private executive role was negative.', 'personal', one('personal', 'sensitive', 'The candidate evaluation for a private executive role was negative.')),
  row('personal-07', 'personal', 'Keep Ivan\'s relationship information confidential.', 'personal', one('personal', 'sensitive', 'Keep Ivan\'s relationship information confidential.')),
  row('personal-08', 'personal', 'Ivan is resolving a personal legal dispute with his landlord.', 'personal', one('personal', 'sensitive', 'Ivan is resolving a personal legal dispute with his landlord.')),

  row('mixed-01', 'mixed', 'Atlas delivery moved to Friday because Ivan has a medical appointment.', 'mixed', mixed('Atlas delivery moved to Friday.', 'Ivan has a medical appointment.'), { work: ['atlas', 'friday'], sensitive: ['ivan', 'medical'] }),
  row('mixed-02', 'mixed', 'Maya will cover Saturday on-call because Ivan has a family emergency.', 'mixed', mixed('Maya will cover Saturday on-call.', 'Ivan has a family emergency.'), { work: ['maya', 'saturday', 'on-call'], sensitive: ['ivan', 'family'] }),
  row('mixed-03', 'mixed', 'The hiring budget was revised after Ivan received a compensation adjustment.', 'mixed', mixed('The hiring budget was revised.', 'Ivan received a compensation adjustment.'), { work: ['hiring', 'budget'], sensitive: ['ivan', 'compensation'] }),
  row('mixed-04', 'mixed', 'The database migration was reassigned because the engineer is under performance review.', 'mixed', mixed('The database migration was reassigned.', 'The engineer is under performance review.'), { work: ['database', 'migration', 'reassigned'], sensitive: ['engineer', 'performance'] }),

  row('uncertain-01', 'semantic_uncertain', 'The Atlas migration might move to Friday, but the date is not final.', 'semantic_uncertain', one('semantic_uncertain', 'work', 'The Atlas migration might move to Friday, but the date is not final.')),
  row('uncertain-02', 'semantic_uncertain', 'It is unclear whether the vendor rollout needs one extra review.', 'semantic_uncertain', one('semantic_uncertain', 'work', 'It is unclear whether the vendor rollout needs one extra review.')),

  row('secret-01', 'known_secret', 'The database password: route-gate-fake-secret.', 'quarantine', null),
  row('secret-02', 'known_secret', `The AWS access key is ${'AKIAIOSFODNN7EXAMPLE'}.`, 'quarantine', null),
  row('secret-03', 'prose_secret', 'My password is swordfish-fake-value.', 'quarantine', null),
  row('secret-04', 'prose_secret', 'The API key is route-gate-prose-fake-value.', 'quarantine', null),
]);

export function loadRoutingFixtures() {
  return FIXTURES.map((fixture) => ({
    ...fixture,
    oracleOutput: fixture.oracleOutput ? structuredClone(fixture.oracleOutput) : null,
    matchers: { ...fixture.matchers },
  }));
}

export function fixtureManifestHash(fixtures = loadRoutingFixtures()) {
  return crypto.createHash('sha256').update(JSON.stringify(fixtures.map((fixture) => ({
    id: fixture.id,
    family: fixture.family,
    fact: fixture.fact,
    expected: fixture.expected,
    oracleOutput: fixture.oracleOutput,
    matchers: fixture.matchers,
  })))).digest('hex');
}
