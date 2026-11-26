import { env } from '$env/dynamic/private';
import { isPhoneOptedOut } from '$lib/server/whatsapp-optout';

export type WhatsAppProvider = 'whapi' | 'zapi' | 'evolution' | 'greenapi' | 'meta' | 'simulation';

export interface GatewayOverrideConfig {
  provider?: WhatsAppProvider;
  apiUrl?: string;
  apiToken?: string;
  instanceId?: string;
}

export interface SendWhatsAppResult {
  ok: boolean;
  provider: WhatsAppProvider;
  simulated: boolean;
  blockedByOptOut?: boolean;
  notOnWhatsApp?: boolean;
  phone: string;
  phoneType: 'mobile' | 'landline' | 'unknown';
  messageId?: string;
  timestamp: string;
  error?: string;
}

export interface WhatsAppNumberCheckResult {
  input: string;
  normalized: string;
  valid: boolean;
  waId: string | null;
  status: string;
}

function getBrazilPhoneFallback12(normPhone: string): string | null {
  // Para celulares BR com 13 dígitos (55 + DDD + 9 + 8 dígitos) em DDD >= 31,
  // algumas contas WhatsApp antigas ainda respondem pelo JID de 12 dígitos (sem o 9 extra).
  if (normPhone.startsWith('55') && normPhone.length === 13 && normPhone[4] === '9') {
    const ddd = parseInt(normPhone.slice(2, 4), 10);
    if (ddd >= 31) {
      return normPhone.slice(0, 4) + normPhone.slice(5);
    }
  }
  return null;
}

export async function checkWhapiNumbers(
  rawPhones: string[],
  overrideConfig?: GatewayOverrideConfig
): Promise<{
  ok: boolean;
  provider: WhatsAppProvider;
  results: WhatsAppNumberCheckResult[];
  error?: string;
}> {
  const { provider, apiUrl, apiToken } = resolveGatewayConfig(overrideConfig);
  if (provider !== 'whapi' || !apiToken) {
    return {
      ok: false,
      provider,
      results: [],
      error: `Validação de número só é suportada no provider whapi (atual: ${provider}).`
    };
  }

  const normalizedInputs = rawPhones.map((raw) => ({
    raw,
    normalized: normalizeBrazilPhone(raw) || ''
  }));

  const uniqueCandidates = new Set<string>();
  for (const item of normalizedInputs) {
    if (!item.normalized) continue;
    uniqueCandidates.add(item.normalized);
    const fb12 = getBrazilPhoneFallback12(item.normalized);
    if (fb12) uniqueCandidates.add(fb12);
  }

  if (uniqueCandidates.size === 0) {
    return { ok: true, provider, results: [] };
  }

  try {
    const res = await fetch(`${apiUrl}/contacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        blocking: 'wait',
        contacts: Array.from(uniqueCandidates)
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        provider,
        results: [],
        error: data?.error?.message || data?.message || `Whapi /contacts HTTP ${res.status}`
      };
    }

    const byInput = new Map<string, { status: string; wa_id?: string }>();
    const contactsArr: any[] = Array.isArray(data?.contacts) ? data.contacts : [];
    for (const c of contactsArr) {
      const key = String(c?.input || '').replace(/\D/g, '');
      if (key) {
        byInput.set(key, { status: String(c?.status || 'unknown'), wa_id: c?.wa_id ? String(c.wa_id) : undefined });
      }
    }

    const results: WhatsAppNumberCheckResult[] = normalizedInputs.map(({ raw, normalized }) => {
      if (!normalized) {
        return { input: raw, normalized: '', valid: false, waId: null, status: 'invalid_format' };
      }
      const primary = byInput.get(normalized);
      if (primary?.status === 'valid' && primary.wa_id) {
        return { input: raw, normalized, valid: true, waId: primary.wa_id, status: 'valid' };
      }
      const fb12 = getBrazilPhoneFallback12(normalized);
      if (fb12) {
        const secondary = byInput.get(fb12);
        if (secondary?.status === 'valid' && secondary.wa_id) {
          return { input: raw, normalized, valid: true, waId: secondary.wa_id, status: 'valid_12digit' };
        }
      }
      return {
        input: raw,
        normalized,
        valid: false,
        waId: null,
        status: primary?.status || 'invalid'
      };
    });

    return { ok: true, provider, results };
  } catch (err: any) {
    return {
      ok: false,
      provider,
      results: [],
      error: err?.message || 'Erro de rede ao validar números no Whapi.'
    };
  }
}

export function normalizeBrazilPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.toString().replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.startsWith('55') && digits.length >= 12) {
    return digits;
  }
  return `55${digits}`;
}

export function classifyBrazilPhoneType(raw: string | null | undefined): 'mobile' | 'landline' | 'unknown' {
  const norm = normalizeBrazilPhone(raw);
  if (!norm || norm.length < 12) return 'unknown';
  const localNumber = norm.slice(4); // after 55 + 2-digit DDD
  if (localNumber.length === 9 && localNumber.startsWith('9')) return 'mobile';
  if (localNumber.length === 8 && (localNumber.startsWith('8') || localNumber.startsWith('9') || localNumber.startsWith('7'))) {
    return 'mobile';
  }
  return 'landline';
}

export function getBrasiliaTimeInfo(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  const parts = formatter.formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const hour = parseInt(partMap.hour || '0', 10);
  const minute = parseInt(partMap.minute || '0', 10);
  const weekdayStr = (partMap.weekday || '').toLowerCase();
  const isWeekend = weekdayStr.includes('sáb') || weekdayStr.includes('sab') || weekdayStr.includes('dom');

  const decimalHour = hour + minute / 60;
  // Business hours: Monday–Friday, 09:00 to 17:30 BRT
  const isBusinessHours = !isWeekend && decimalHour >= 9.0 && decimalHour <= 17.5;

  return {
    isBusinessHours,
    isWeekend,
    hour,
    minute,
    formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} BRT`,
    weekday: partMap.weekday || ''
  };
}

export function resolveGatewayConfig(override?: GatewayOverrideConfig) {
  const apiToken = (override?.apiToken || env.WHATSAPP_API_TOKEN || process.env.WHATSAPP_API_TOKEN || '').trim();
  let apiUrl = (override?.apiUrl || env.WHATSAPP_API_URL || process.env.WHATSAPP_API_URL || '').trim().replace(/\/+$/, '');
  const instanceId = (override?.instanceId || env.WHATSAPP_INSTANCE_ID || process.env.WHATSAPP_INSTANCE_ID || 'triade').trim();
  const rawProvider = (override?.provider || env.WHATSAPP_PROVIDER || process.env.WHATSAPP_PROVIDER || '').toLowerCase().trim();

  if (!apiToken) {
    return { provider: 'simulation' as WhatsAppProvider, apiUrl: '', apiToken: '', instanceId };
  }

  if (rawProvider === 'meta' || apiUrl.includes('graph.facebook.com')) {
    return {
      provider: 'meta' as WhatsAppProvider,
      apiUrl: apiUrl || 'https://graph.facebook.com/v22.0',
      apiToken,
      instanceId
    };
  }

  if (rawProvider === 'zapi' || apiUrl.includes('z-api.io')) {
    return { provider: 'zapi' as WhatsAppProvider, apiUrl, apiToken, instanceId };
  }

  if (rawProvider === 'greenapi' || apiUrl.includes('green-api.com')) {
    return { provider: 'greenapi' as WhatsAppProvider, apiUrl, apiToken, instanceId };
  }

  if (rawProvider === 'whapi' || apiUrl.includes('whapi.cloud') || (!apiUrl && apiToken.length >= 20)) {
    return {
      provider: 'whapi' as WhatsAppProvider,
      apiUrl: apiUrl || 'https://gate.whapi.cloud',
      apiToken,
      instanceId
    };
  }

  if (apiUrl) {
    return { provider: 'evolution' as WhatsAppProvider, apiUrl, apiToken, instanceId };
  }

  return { provider: 'simulation' as WhatsAppProvider, apiUrl: '', apiToken: '', instanceId };
}

export function getActiveWhatsAppProvider(override?: GatewayOverrideConfig): WhatsAppProvider {
  return resolveGatewayConfig(override).provider;
}

export interface MetaTemplatePayload {
  name: string;
  languageCode?: string;
  bodyParameters?: string[];
}

export async function sendWhatsAppText(
  rawPhone: string,
  text: string,
  options: {
    simulateTypingMs?: number;
    overrideConfig?: GatewayOverrideConfig;
    bypassOptOutCheck?: boolean;
    validateBeforeSend?: boolean;
    metaTemplate?: MetaTemplatePayload;
  } = {}
): Promise<SendWhatsAppResult> {
  const phone = normalizeBrazilPhone(rawPhone);
  const phoneType = classifyBrazilPhoneType(rawPhone);
  const timestamp = new Date().toISOString();

  if (!phone) {
    return {
      ok: false,
      provider: 'simulation',
      simulated: true,
      phone: rawPhone || '',
      phoneType,
      timestamp,
      error: 'Número de telefone inválido ou ausente.'
    };
  }

  const { provider, apiUrl, apiToken, instanceId } = resolveGatewayConfig(options.overrideConfig);
  const typingMs = options.simulateTypingMs ?? 3500;

  if (!options.bypassOptOutCheck) {
    const optOutCheck = await isPhoneOptedOut(phone);
    if (optOutCheck.blocked) {
      return {
        ok: false,
        provider,
        simulated: false,
        blockedByOptOut: true,
        phone,
        phoneType,
        timestamp,
        error: optOutCheck.reason || 'Contato bloqueado (Opt-Out / PARAR).'
      };
    }
  }

  if (provider === 'simulation') {
    return {
      ok: true,
      provider: 'simulation',
      simulated: true,
      phone,
      phoneType,
      messageId: `sim_${Date.now()}`,
      timestamp
    };
  }

  try {
    if (provider === 'whapi') {
      let targetPhone = phone;

      if (options.validateBeforeSend) {
        const check = await checkWhapiNumbers([phone], options.overrideConfig);
        if (!check.ok) {
          throw new Error(check.error || 'Falha ao validar número no Whapi.');
        }
        const match = check.results[0];
        if (!match?.valid || !match.waId) {
          return {
            ok: false,
            provider: 'whapi',
            simulated: false,
            notOnWhatsApp: true,
            phone,
            phoneType,
            timestamp,
            error: `Número não cadastrado no WhatsApp (${match?.status || 'invalid'}).`
          };
        }
        targetPhone = match.waId.replace(/@.*$/, '');
      }

      const res = await fetch(`${apiUrl}/messages/text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${apiToken}`
        },
        body: JSON.stringify({
          to: targetPhone,
          body: text,
          typing_time: Math.min(10, Math.max(2, Math.round(typingMs / 1000))),
          no_link_preview: true
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error?.message || data?.message || `Whapi.cloud HTTP ${res.status}`);
      }

      return {
        ok: true,
        provider: 'whapi',
        simulated: false,
        phone: targetPhone,
        phoneType,
        messageId: data?.message?.id || `whapi_${Date.now()}`,
        timestamp
      };
    }

    if (provider === 'greenapi') {
      const endpoint = `${apiUrl}/waInstance${instanceId}/sendMessage/${apiToken}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: `${phone}@c.us`,
          message: text
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || `Green-API HTTP ${res.status}`);
      }

      return {
        ok: true,
        provider: 'greenapi',
        simulated: false,
        phone,
        phoneType,
        messageId: data?.idMessage || `green_${Date.now()}`,
        timestamp
      };
    }

    if (provider === 'evolution') {
      if (typingMs > 0) {
        try {
          await fetch(`${apiUrl}/chat/sendPresence/${instanceId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: apiToken },
            body: JSON.stringify({
              number: phone,
              options: { delay: typingMs, presence: 'composing' }
            })
          });
        } catch {}
      }

      const res = await fetch(`${apiUrl}/message/sendText/${instanceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: apiToken },
        body: JSON.stringify({
          number: phone,
          text,
          options: { delay: typingMs, presence: 'composing', linkPreview: false }
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || `Evolution API HTTP ${res.status}`);
      }

      return {
        ok: true,
        provider: 'evolution',
        simulated: false,
        phone,
        phoneType,
        messageId: data?.key?.id || `evo_${Date.now()}`,
        timestamp
      };
    }

    if (provider === 'zapi') {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiToken && !apiUrl.includes('/token/')) {
        headers['Client-Token'] = apiToken;
      }

      const res = await fetch(`${apiUrl}/send-text`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          phone,
          message: text,
          delayTyping: Math.min(15, Math.max(2, Math.round(typingMs / 1000)))
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        throw new Error(data?.error || `Z-API HTTP ${res.status}`);
      }

      return {
        ok: true,
        provider: 'zapi',
        simulated: false,
        phone,
        phoneType,
        messageId: data?.messageId || data?.zaapId || `zapi_${Date.now()}`,
        timestamp
      };
    }

    if (provider === 'meta') {
      const metaBody = options.metaTemplate
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'template',
            template: {
              name: options.metaTemplate.name,
              language: { code: options.metaTemplate.languageCode || 'pt_BR' },
              ...(options.metaTemplate.bodyParameters?.length
                ? {
                    components: [
                      {
                        type: 'body',
                        parameters: options.metaTemplate.bodyParameters.map((p) => ({
                          type: 'text',
                          text: p
                        }))
                      }
                    ]
                  }
                : {})
            }
          }
        : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'text',
            text: { preview_url: false, body: text }
          };

      const res = await fetch(`${apiUrl}/${instanceId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`
        },
        body: JSON.stringify(metaBody)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error?.message || `Meta Cloud API HTTP ${res.status}`);
      }

      return {
        ok: true,
        provider: 'meta',
        simulated: false,
        phone,
        phoneType,
        messageId: data?.messages?.[0]?.id || `meta_${Date.now()}`,
        timestamp
      };
    }

    return {
      ok: true,
      provider: 'simulation',
      simulated: true,
      phone,
      phoneType,
      messageId: `sim_${Date.now()}`,
      timestamp
    };
  } catch (err: any) {
    return {
      ok: false,
      provider,
      simulated: false,
      phone,
      phoneType,
      timestamp,
      error: err?.message || 'Erro desconhecido ao enviar mensagem WhatsApp.'
    };
  }
}

export function buildTwoStepOpenerMessage(lead: any): string {
  const orgName = lead?.osc?.nome || 'equipe';
  const city = lead?.osc?.municipio ? ` em ${lead.osc.municipio}` : '';
  const valor = lead?.edital_valor
    ? lead.edital_valor >= 1000000
      ? `R$ ${(lead.edital_valor / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
      : lead.edital_valor >= 1000
        ? `R$ ${(lead.edital_valor / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`
        : `R$ ${lead.edital_valor.toLocaleString('pt-BR')}`
    : 'valor expressivo';

  return `Olá, pessoal da ${orgName}, tudo bem? Aqui é da equipe da Maria Angela, da Triade Captação de Recursos. Vimos a atuação de vocês${city} e mapeamos um edital aberto de até ${valor} muito alinhado ao perfil da instituição. Posso enviar um resumo rápido por aqui?`;
}

export {
  buildDiagnosticoOpenerMessage,
  buildDiagnosticoLinkReplyMessage,
  buildDiagnosticoUrl
} from '$lib/server/diagnostico-whatsapp';