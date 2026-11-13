import { env } from '$env/dynamic/private';

export type WhatsAppProvider = 'evolution' | 'zapi' | 'meta' | 'simulation';

export interface SendWhatsAppResult {
  ok: boolean;
  provider: WhatsAppProvider;
  simulated: boolean;
  phone: string;
  messageId?: string;
  timestamp: string;
  error?: string;
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

export function getActiveWhatsAppProvider(): WhatsAppProvider {
  const configured = (env.WHATSAPP_PROVIDER || '').toLowerCase().trim();
  const apiUrl = (env.WHATSAPP_API_URL || '').trim();
  const apiToken = (env.WHATSAPP_API_TOKEN || '').trim();

  if (!apiUrl || !apiToken) {
    return 'simulation';
  }
  if (configured === 'evolution' || configured === 'zapi' || configured === 'meta') {
    return configured;
  }
  if (apiUrl.includes('z-api.io')) return 'zapi';
  if (apiUrl.includes('graph.facebook.com')) return 'meta';
  return 'evolution';
}

export async function sendWhatsAppText(
  rawPhone: string,
  text: string,
  options: { simulateTypingMs?: number } = {}
): Promise<SendWhatsAppResult> {
  const phone = normalizeBrazilPhone(rawPhone);
  const timestamp = new Date().toISOString();
  if (!phone) {
    return {
      ok: false,
      provider: 'simulation',
      simulated: true,
      phone: rawPhone || '',
      timestamp,
      error: 'Número de telefone inválido ou ausente.'
    };
  }

  const provider = getActiveWhatsAppProvider();
  const apiUrl = (env.WHATSAPP_API_URL || '').replace(/\/+$/, '');
  const apiToken = env.WHATSAPP_API_TOKEN || '';
  const instanceId = env.WHATSAPP_INSTANCE_ID || 'triade';
  const typingMs = options.simulateTypingMs ?? 3500;

  if (provider === 'simulation') {
    return {
      ok: true,
      provider: 'simulation',
      simulated: true,
      phone,
      messageId: `sim_${Date.now()}`,
      timestamp
    };
  }

  try {
    if (provider === 'evolution') {
      // Optional typing indicator ("digitando...") before sending
      if (typingMs > 0) {
        try {
          await fetch(`${apiUrl}/chat/sendPresence/${instanceId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: apiToken
            },
            body: JSON.stringify({
              number: phone,
              options: { delay: typingMs, presence: 'composing' }
            })
          });
        } catch {}
      }

      const res = await fetch(`${apiUrl}/message/sendText/${instanceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: apiToken
        },
        body: JSON.stringify({
          number: phone,
          text,
          options: {
            delay: typingMs,
            presence: 'composing',
            linkPreview: false
          }
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
        messageId: data?.key?.id || `evo_${Date.now()}`,
        timestamp
      };
    }

    if (provider === 'zapi') {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiToken) headers['Client-Token'] = apiToken;

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
      if (!res.ok) {
        throw new Error(data?.error || `Z-API HTTP ${res.status}`);
      }

      return {
        ok: true,
        provider: 'zapi',
        simulated: false,
        phone,
        messageId: data?.messageId || data?.zaapId || `zapi_${Date.now()}`,
        timestamp
      };
    }

    if (provider === 'meta') {
      const res = await fetch(`${apiUrl}/${instanceId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: false, body: text }
        })
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
        messageId: data?.messages?.[0]?.id || `meta_${Date.now()}`,
        timestamp
      };
    }

    return {
      ok: true,
      provider: 'simulation',
      simulated: true,
      phone,
      messageId: `sim_${Date.now()}`,
      timestamp
    };
  } catch (err: any) {
    return {
      ok: false,
      provider,
      simulated: false,
      phone,
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
