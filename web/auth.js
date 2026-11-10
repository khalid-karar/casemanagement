// Sign-in for the web app. Dev mode: a user switcher. OIDC mode: Authorization Code + PKCE against Keycloak.
// The access token is kept in memory only (never localStorage); a page reload re-uses the identity provider's session.
window.Auth = (() => {
  let cfg = { mode: 'dev' }, token = null, me = null;
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = (n) => b64(crypto.getRandomValues(new Uint8Array(n)));
  const redirectUri = () => location.origin + '/';
  const ep = (p) => `${cfg.issuer}/protocol/openid-connect/${p}`;

  async function init() {
    cfg = await (await fetch('/auth/config')).json();
    if (cfg.mode !== 'oidc') return;
    const q = new URLSearchParams(location.search);
    if (q.get('code')) {
      const ok = q.get('state') === sessionStorage.getItem('pkce_state');
      const verifier = sessionStorage.getItem('pkce_verifier');
      sessionStorage.removeItem('pkce_state'); sessionStorage.removeItem('pkce_verifier');
      history.replaceState({}, '', '/');
      if (!ok || !verifier) return login();
      const r = await fetch(ep('token'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.clientId, code: q.get('code'), redirect_uri: redirectUri(), code_verifier: verifier }) });
      if (!r.ok) return login();
      token = (await r.json()).access_token;
    } else return login();
    me = await (await fetch('/me', { headers: { authorization: 'Bearer ' + token } })).json();
  }

  async function login() {
    const verifier = rand(48), state = rand(16);
    sessionStorage.setItem('pkce_verifier', verifier); sessionStorage.setItem('pkce_state', state);
    const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    location.href = ep('auth') + '?' + new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri(), scope: 'openid', state, code_challenge: challenge, code_challenge_method: 'S256' });
    await new Promise(() => {}); // navigation in progress
  }
  const logout = () => { token = null; location.href = ep('logout') + '?' + new URLSearchParams({ client_id: cfg.clientId, post_logout_redirect_uri: redirectUri() }); };
  return { init, logout, get mode() { return cfg.mode; }, get me() { return me; }, header: (devUser) => 'Bearer ' + (cfg.mode === 'oidc' ? token : 'dev:' + devUser) };
})();
