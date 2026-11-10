import type { AiSettings } from './consent';
import { consentValid } from './consent';
import type { ChatProvider } from './provider';

export interface InKingdomProvider { provider: ChatProvider; name: string; region: string }
export interface AiProviders { sovereign?: ChatProvider; inKingdom?: InKingdomProvider }

export type Selection =
  | { ok: true; provider: ChatProvider; mode: 'sovereign' | 'in_kingdom'; label: string; external: boolean; includePersonal: boolean }
  | { ok: false; reason: 'NO_PROVIDER' };

/**
 * Which model may see this tenant's data. Fail-closed: the external provider is used only with a valid,
 * current, unrevoked signed consent. Without it the tenant falls back to the sovereign model, or AI is off.
 * The platform tenant handles public national law only, so it may use either engine without consent.
 */
export function selectProvider(tenantId: string, settings: AiSettings, p: AiProviders): Selection {
  const ext = p.inKingdom;
  if (tenantId === 'platform') {
    if (ext) return { ok: true, provider: ext.provider, mode: 'in_kingdom', label: `${ext.name} (${ext.region})`, external: true, includePersonal: false };
    if (p.sovereign) return { ok: true, provider: p.sovereign, mode: 'sovereign', label: `own model (${p.sovereign.model})`, external: false, includePersonal: true };
    return { ok: false, reason: 'NO_PROVIDER' };
  }
  if (ext && consentValid(settings, { providerName: ext.name, region: ext.region })) {
    return { ok: true, provider: ext.provider, mode: 'in_kingdom', label: `${ext.name} (${ext.region})`, external: true, includePersonal: settings.consent!.includePersonal };
  }
  if (p.sovereign) return { ok: true, provider: p.sovereign, mode: 'sovereign', label: `own model (${p.sovereign.model})`, external: false, includePersonal: true };
  return { ok: false, reason: 'NO_PROVIDER' };
}
