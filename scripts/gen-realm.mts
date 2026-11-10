import { writeFileSync } from 'node:fs';
import { knownRoles } from '../src/api/oidc';

const dev = process.argv.includes('--dev-users');
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
const users = !dev ? [] : [
  ['hr-mgr', 'neom', ['HR'], ['hr_manager'], 'STANDARD'],
  ['hr-inv', 'neom', ['HR'], ['hr_investigator'], 'STANDARD'],
  ['hr-dir', 'neom', ['HR'], ['hr_director'], 'RESTRICTED'],
  ['client-admin', 'neom', ['HR'], ['tenant_admin'], 'STANDARD'],
  ['editor', 'platform', ['LEGAL'], ['legal_content_editor'], 'RESTRICTED'],
  ['verifier', 'platform', ['LEGAL'], ['legal_verifier'], 'RESTRICTED'],
].map(([u, tenant, deps, roles, clr]) => ({
  username: u, email: `${u}@example.invalid`, firstName: String(u), lastName: 'Test', enabled: true, emailVerified: true,
  attributes: { tenant_id: [tenant], departments: deps, clearance: [clr] },
  credentials: [{ type: 'password', value: 'Test-Only-Passw0rd!', temporary: false }],
  realmRoles: roles,
}));

const realm = {
  realm: 'cms', enabled: true, displayName: 'Case Management',
  sslRequired: 'external', registrationAllowed: false, resetPasswordAllowed: true, loginWithEmailAllowed: false, duplicateEmailsAllowed: false,
  bruteForceProtected: true, failureFactor: 5, maxFailureWaitSeconds: 900, permanentLockout: false,
  passwordPolicy: 'length(12) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notUsername and passwordHistory(5)',
  accessTokenLifespan: 300, ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 36000,
  revokeRefreshToken: true, refreshTokenMaxReuse: 0,
  internationalizationEnabled: true, supportedLocales: ['ar', 'en'], defaultLocale: 'ar',
  eventsEnabled: true, adminEventsEnabled: true, adminEventsDetailsEnabled: true, eventsExpiration: 31536000,
  otpPolicyType: 'totp', otpPolicyAlgorithm: 'HmacSHA256', otpPolicyDigits: 6, otpPolicyPeriod: 30,
  // Multi-factor is mandatory for every user (NCA ECC). Dev users skip it so automated tests can sign in.
  requiredActions: [{ alias: 'CONFIGURE_TOTP', name: 'Configure OTP', providerId: 'CONFIGURE_TOTP', enabled: true, defaultAction: !dev, priority: 10 }],
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
  }],
  users,
  components: { 'org.keycloak.userprofile.UserProfileProvider': [{ providerId: 'declarative-user-profile', config: { 'kc.user.profile.config': [JSON.stringify(profile)] } }] },
};
writeFileSync(process.argv[2]!, JSON.stringify(realm, null, 2));
console.log('wrote', process.argv[2]);
