/**
 * Token revocation. Access tokens are short-lived but valid until they expire; this closes that window:
 * once a person is revoked (signed out through the identity provider, or removed by an admin), any token issued
 * before that moment is rejected immediately, on every server, within `pollMs` (default 10s) at worst.
 */
export interface RevocationStore {
  loadRevocations(): Promise<Record<string, number>>;
  setRevocation(subject: string, notBefore: number): Promise<void>;
}

export class Revocations {
  private map = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private store: RevocationStore, private pollMs = 10_000) {}

  async start() {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh().catch((e) => console.error('revocation refresh failed', (e as Error).message)); }, this.pollMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  async refresh() { for (const [s, nb] of Object.entries(await this.store.loadRevocations())) this.map.set(s, Math.max(nb, this.map.get(s) ?? 0)); }

  /** True when this token (issued at `iat`, unix seconds) predates the person's revocation. A token with no iat is refused once the person is revoked. */
  isRevoked(subject: string, iat: number | undefined): boolean {
    const nb = this.map.get(subject);
    return nb !== undefined && (iat === undefined || iat < nb);
  }
  async revoke(subject: string, atSec = Math.floor(Date.now() / 1000)) {
    this.map.set(subject, Math.max(atSec, this.map.get(subject) ?? 0));
    await this.store.setRevocation(subject, atSec);
  }
}
