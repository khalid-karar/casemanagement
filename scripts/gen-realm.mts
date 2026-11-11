import { writeFileSync } from 'node:fs';
import { knownRoles } from '../src/api/oidc';
import { TEST_USERS } from '../src/api/test-users';

/**
 * `--qa` (alias: `--dev-users`) emits a SEPARATE realm for the QA environment: the same hardening,
 * plus the test-user matrix from src/api/test-users.ts, TOTP enrolment not forced, and a
 * `case-qa` client with direct password grants so API tests can get a token without a browser.
 * The production realm (no users, TOTP mandatory, no password grant) is the default output and is
 * what the penetration test must run against. Never import the QA realm into a real environment.
 */
const qa = process.argv.includes('--qa') || process.argv.includes('--dev-users');
const QA_PASSWORD = 'Qa-Test-Only-Passw0rd!';
const attrs = ['tenant_id', 'departments', 'clearance', 'reports_to', 'actor_kind', 'counsel_matter_ids'];
const multi = new Set(['departments', 'reports_to', 'counsel_matter_ids']);
const mapper = (a: string) => ({
  name: a, protocol: 'openid-connect', protocolMapper: 'oidc-usermodel-attribute-mapper',
  config: { 'user.attribute': a, 'claim.name': a, 'jsonType.label': 'String', 'multivalued': String(multi.has(a)), 'access.token.claim': 'true', 'id.token.claim': 'false', 'userinfo.token.claim': 'false' },
});
const profile = {
  attributes: [
    { name: 'username', validations: { length: { min: 3, max: 255 } }, permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] } },
    { name: 'email', validations: { email: {} }, required: { roles: ['user'] }, permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] } },
    { name: 'firstName', required: { roles: ['user'] }, permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] } },
    { name: 'lastName', required: { roles: ['user'] }, permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] } },
    // Authorization attributes: only administrators may set them. Users can neither see nor edit their own.
    ...attrs.map((name) => ({ name, multivalued: multi.has(name), permissions: { view: ['admin'], edit: ['admin'] } })),
  ],
};
const users = !qa ? [] : TEST_USERS.map((u) => ({
  username: u.id, email: `${u.id}@example.invalid`, firstName: u.id, lastName: 'Test', enabled: true, emailVerified: true,
  attributes: {
    tenant_id: [u.tenantId], departments: u.departments, clearance: [u.clearance],
    ...(u.kind === 'external' ? { actor_kind: ['external'] } : {}),
    ...(u.counselMatterIds ? { counsel_matter_ids: u.counselMatterIds } : {}),
  },
  credentials: [{ type: 'password', value: QA_PASSWORD, temporary: false }],
  realmRoles: u.roles,
}));

/** QA-only client: password grant, so test scripts can fetch a token without driving a browser. */
const qaClient = {
  clientId: 'case-qa', name: 'QA test client (non-production)', enabled: true, publicClient: true,
  standardFlowEnabled: false, directAccessGrantsEnabled: true, implicitFlowEnabled: false, serviceAccountsEnabled: false,
  protocolMappers: [
    { name: 'audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.custom.audience': 'case-api', 'access.token.claim': 'true', 'id.token.claim': 'false' } },
    ...attrs.map(mapper),
  ],
};

const realm = {
  realm: 'cms', enabled: true, displayName: qa ? 'Case Management (QA — test data only)' : 'Case Management',
  sslRequired: 'external', registrationAllowed: false, resetPasswordAllowed: true, loginWithEmailAllowed: false, duplicateEmailsAllowed: false,
  bruteForceProtected: true, failureFactor: 5, maxFailureWaitSeconds: 900, permanentLockout: false,
  passwordPolicy: 'length(12) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notUsername and passwordHistory(5)',
  accessTokenLifespan: 300, ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 36000,
  revokeRefreshToken: true, refreshTokenMaxReuse: 0,
  internationalizationEnabled: true, supportedLocales: ['ar', 'en'], defaultLocale: 'ar',
  eventsEnabled: true, adminEventsEnabled: true, adminEventsDetailsEnabled: true, eventsExpiration: 31536000,
  otpPolicyType: 'totp', otpPolicyAlgorithm: 'HmacSHA256', otpPolicyDigits: 6, otpPolicyPeriod: 30,
  // Multi-factor is mandatory for every user (NCA ECC). QA users skip enrolment so tests can sign in;
  // the penetration test runs against the production realm, where it is on.
  requiredActions: [{ alias: 'CONFIGURE_TOTP', name: 'Configure OTP', providerId: 'CONFIGURE_TOTP', enabled: true, defaultAction: !qa, priority: 10 }],
  roles: { realm: [...knownRoles()].sort().map((name) => ({ name })) },
  clients: [{
    clientId: 'case-web', name: 'Case Management web app', enabled: true, publicClient: true, standardFlowEnabled: true,
    directAccessGrantsEnabled: false, implicitFlowEnabled: false, serviceAccountsEnabled: false,
    redirectUris: ['http://localhost:8080/', 'http://localhost:3000/', 'https://CHANGE-ME.example.sa/'],
    webOrigins: ['+'], attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': '+' },
    // Built-in scopes (basic: sub, profile: name, roles: realm_access) come from Keycloak's defaults.
    protocolMappers: [
      { name: 'audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.custom.audience': 'case-api', 'access.token.claim': 'true', 'id.token.claim': 'false' } },
      ...attrs.map(mapper),
    ],
  }, ...(qa ? [qaClient] : [])],
  users,
  components: { 'org.keycloak.userprofile.UserProfileProvider': [{ providerId: 'declarative-user-profile', config: { 'kc.user.profile.config': [JSON.stringify(profile)] } }] },
};
writeFileSync(process.argv[2]!, JSON.stringify(realm, null, 2));
console.log(`wrote ${process.argv[2]} (${qa ? `QA realm: ${users.length} test users, password ${QA_PASSWORD}, case-qa password grant` : 'production realm: no users, TOTP enrolment forced'})`);
