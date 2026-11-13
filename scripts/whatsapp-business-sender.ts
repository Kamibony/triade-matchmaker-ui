import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const LEADS_PATH = path.resolve('src/data/daily_outbound_leads.json');
const SENT_LOG_PATH = path.resolve('src/data/whatsapp_sent_log.json');

// For the 7-day experiment sending to ALL leads during business hours:
// 4 runs/day (09:30, 11:30, 14:30, 16:30 BRT) x 12 leads/run = up to 48 leads/day safely!
const MAX_MESSAGES_PER_RUN = parseInt(process.env.MAX_MESSAGES_PER_RUN || '8', 10);
const MAX_DAILY_SENT = parseInt(process.env.MAX_DAILY_SENT || '35', 10);
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '0', 10); // Default 0 = send to ALL leads for 7-day data analysis
const USE_TWO_STEP_OPENER = (process.env.USE_TWO_STEP_OPENER || 'true').toLowerCase() !== 'false';
const FORCE_OUTSIDE_BUSINESS_HOURS = (process.env.FORCE_OUTSIDE_BUSINESS_HOURS || 'false').toLowerCase() === 'true';

function getBrasiliaTimeInfo() {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(new Date());
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const hour = parseInt(map.hour || '0', 10);
  const minute = parseInt(map.minute || '0', 10);
  const weekday = (map.weekday || '').toLowerCase();
  const isWeekend = weekday.includes('sáb') || weekday.includes('sab') || weekday.includes('dom');
  const decimal = hour + minute / 60;
  const isBusinessHours = !isWeekend && decimal >= 9.0 && decimal <= 17.5;

  return {
    isBusinessHours,
    formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} BRT (${map.weekday})`
  };
}

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.toString().replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits}`;
}

function classifyPhoneType(norm: string): 'mobile' | 'landline' {
  const local = norm.slice(4);
  if (local.length === 9 && local.startsWith('9')) return 'mobile';
  if (local.length === 8 && (local.startsWith('8') || local.startsWith('9') || local.startsWith('7'))) return 'mobile';
  return 'landline';
}

function buildTwoStepOpener(lead: any): string {
  const orgName = lead?.osc?.nome || 'equipe';
  const city = lead?.osc?.municipio ? ` em ${lead.osc.municipio}` : '';
  const val = lead?.edital_valor;
  const valorStr = val
    ? val >= 1000000
      ? `R$ ${(val / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
      : val >= 1000
        ? `R$ ${(val / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`
        : `R$ ${val}`
    : 'valor expressivo';

  return `Olá, pessoal da ${orgName}, tudo bem? Aqui é da equipe da Maria Angela, da Triade Captação de Recursos. Vimos a atuação de vocês${city} e mapeamos um edital aberto de até ${valorStr} muito alinhado ao perfil da instituição. Posso enviar um resumo rápido por aqui?`;
}

async function sendViaGateway(phone: string, text: string) {
  let apiUrl = (process.env.WHATSAPP_API_URL || '').trim().replace(/\/+$/, '');
  const apiToken = (process.env.WHATSAPP_API_TOKEN || '').trim();
  const provider = (process.env.WHATSAPP_PROVIDER || '').toLowerCase().trim();
  const instanceId = (process.env.WHATSAPP_INSTANCE_ID || 'triade').trim();

  if (!apiToken) {
    console.log(`   🧪 [SIMULAÇÃO - Sem WHATSAPP_API_TOKEN] Mensagem preparada para +${phone}: "${text.slice(0, 80)}..."`);
    return { ok: true, simulated: true };
  }

  // Whapi.cloud support (only requires WHATSAPP_API_TOKEN)
  if (provider === 'whapi' || apiUrl.includes('whapi.cloud') || !apiUrl) {
    apiUrl = apiUrl || 'https://gate.whapi.cloud';
    const res = await fetch(`${apiUrl}/messages/text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        to: phone,
        body: text,
        typing_time: 4,
        no_link_preview: true
      })
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const detail = errBody?.error?.message || errBody?.message || '';
      throw new Error(`Whapi.cloud HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
    }
    return { ok: true, simulated: false };
  }

  if (provider === 'zapi' || apiUrl.includes('z-api.io')) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiToken && !apiUrl.includes('/token/')) headers['Client-Token'] = apiToken;
    const res = await fetch(`${apiUrl}/send-text`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone, message: text, delayTyping: 4 })
    });
    if (!res.ok) throw new Error(`Z-API HTTP ${res.status}`);
    return { ok: true, simulated: false };
  }

  if (provider === 'greenapi' || apiUrl.includes('green-api.com')) {
    const res = await fetch(`${apiUrl}/waInstance${instanceId}/sendMessage/${apiToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: `${phone}@c.us`, message: text })
    });
    if (!res.ok) throw new Error(`Green-API HTTP ${res.status}`);
    return { ok: true, simulated: false };
  }

  if (provider === 'meta' || apiUrl.includes('graph.facebook.com')) {
    const res = await fetch(`${apiUrl}/${instanceId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { preview_url: false, body: text }
      })
    });
    if (!res.ok) throw new Error(`Meta Cloud API HTTP ${res.status}`);
    return { ok: true, simulated: false };
  }

  // Default: Evolution API
  const res = await fetch(`${apiUrl}/message/sendText/${instanceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiToken },
    body: JSON.stringify({
      number: phone,
      text,
      options: { delay: 4000, presence: 'composing', linkPreview: false }
    })
  });
  if (!res.ok) throw new Error(`Evolution API HTTP ${res.status}`);
  return { ok: true, simulated: false };
}

async function checkHasWhatsAppViaWhapi(phone: string): Promise<boolean> {
  const apiToken = (process.env.WHATSAPP_API_TOKEN || '').trim();
  const provider = (process.env.WHATSAPP_PROVIDER || '').toLowerCase().trim();
  let apiUrl = (process.env.WHATSAPP_API_URL || '').trim().replace(/\/+$/, '');
  if (!apiToken) return true;
  if (provider && provider !== 'whapi' && !apiUrl.includes('whapi.cloud')) return true;
  apiUrl = apiUrl || 'https://gate.whapi.cloud';

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
        contacts: [phone]
      })
    });
    if (!res.ok) return true; // Fail open on API hiccup
    const data = await res.json().catch(() => ({}));
    const entry = Array.isArray(data?.contacts) ? data.contacts[0] : null;
    if (entry && entry.status === 'invalid') {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function getBrasiliaDateStr(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

async function run() {
  const timeInfo = getBrasiliaTimeInfo();
  console.log(`🕒 Horário atual em Brasília: ${timeInfo.formattedTime}`);

  if (!timeInfo.isBusinessHours && !FORCE_OUTSIDE_BUSINESS_HOURS) {
    console.log('🌙 Fora do horário comercial (Seg-Sex, 09:00 às 17:30 BRT). Encerrando sem enviar mensagens.');
    return;
  }

  if (!fs.existsSync(LEADS_PATH)) {
    console.log('⚠️ Arquivo daily_outbound_leads.json não encontrado.');
    return;
  }

  const leads: any[] = JSON.parse(fs.readFileSync(LEADS_PATH, 'utf-8'));
  const sentLog: { last_run_at: string | null; sent_leads: Record<string, any> } = fs.existsSync(SENT_LOG_PATH)
    ? JSON.parse(fs.readFileSync(SENT_LOG_PATH, 'utf-8'))
    : { last_run_at: null, sent_leads: {} };

  const todayBrt = getBrasiliaDateStr();
  const sentEntries = Object.values(sentLog.sent_leads || {});
  const sentTodayCount = sentEntries.filter((e: any) => {
    if (e?.status === 'skipped_no_whatsapp') return false;
    if (!e?.sent_at) return false;
    return getBrasiliaDateStr(new Date(e.sent_at)) === todayBrt;
  }).length;

  const remainingDailyBudget = Math.max(0, MAX_DAILY_SENT - sentTodayCount);
  console.log(`📊 Enviados hoje (${todayBrt} BRT): ${sentTodayCount}/${MAX_DAILY_SENT} (restante hoje: ${remainingDailyBudget}).`);
  if (remainingDailyBudget <= 0) {
    console.log('🛑 Limite diário de segurança atingido. Encerrando até amanhã.');
    return;
  }

  const alreadyContactedPhones = new Set<string>(
    sentEntries.map((e: any) => e?.phone).filter(Boolean)
  );

  const batchLimit = Math.min(MAX_MESSAGES_PER_RUN, remainingDailyBudget);

  const eligible = leads
    .filter(l => {
      const key = `${l.edital_id}_${l.osc?.cnpj}`;
      if (sentLog.sent_leads[key]) return false;
      if ((l.score || 0) < MIN_SCORE) return false;
      const phone = normalizePhone(
        l.contatos_encontrados?.whatsapp ||
          l.osc?.official_contacts?.ddd_telefone_1 ||
          l.osc?.official_contacts?.ddd_telefone_2
      );
      if (!phone || alreadyContactedPhones.has(phone)) return false;
      return true;
    })
    // Prioritize mobile phones first, then higher scores
    .sort((a, b) => {
      const phoneA = normalizePhone(a.contatos_encontrados?.whatsapp || a.osc?.official_contacts?.ddd_telefone_1 || '')!;
      const phoneB = normalizePhone(b.contatos_encontrados?.whatsapp || b.osc?.official_contacts?.ddd_telefone_1 || '')!;
      const typeA = classifyPhoneType(phoneA) === 'mobile' ? 1 : 0;
      const typeB = classifyPhoneType(phoneB) === 'mobile' ? 1 : 0;
      if (typeA !== typeB) return typeB - typeA;
      return (b.score || 0) - (a.score || 0);
    })
    .slice(0, batchLimit);

  console.log(`🚀 Encontrados ${eligible.length} leads inéditos (Score >= ${MIN_SCORE}) para envio cadenciado (limite lote: ${batchLimit}).`);

  for (let i = 0; i < eligible.length; i++) {
    const lead = eligible[i];
    const key = `${lead.edital_id}_${lead.osc?.cnpj}`;
    const phone = normalizePhone(
      lead.contatos_encontrados?.whatsapp ||
        lead.osc?.official_contacts?.ddd_telefone_1 ||
        lead.osc?.official_contacts?.ddd_telefone_2
    )!;

    if (alreadyContactedPhones.has(phone)) {
      console.log(`[${i + 1}/${eligible.length}] ⏭️ Pulando ${lead.osc?.nome} (+${phone}) — telefone já contatado.`);
      continue;
    }

    const phoneType = classifyPhoneType(phone);
    const hasWa = await checkHasWhatsAppViaWhapi(phone);
    if (!hasWa) {
      console.log(`[${i + 1}/${eligible.length}] 📵 Sem WhatsApp ativo: ${lead.osc?.nome} (+${phone}, ${phoneType}) — pulando.`);
      sentLog.sent_leads[key] = {
        cnpj: lead.osc?.cnpj,
        nome: lead.osc?.nome,
        phone,
        phone_type: phoneType,
        status: 'skipped_no_whatsapp',
        checked_at: new Date().toISOString()
      };
      alreadyContactedPhones.add(phone);
      continue;
    }

    const msg = USE_TWO_STEP_OPENER ? buildTwoStepOpener(lead) : lead.whatsapp_message;
    console.log(`[${i + 1}/${eligible.length}] Enviando para ${lead.osc?.nome} (+${phone}, ${phoneType}) - Score ${lead.score}%...`);
    try {
      const res = await sendViaGateway(phone, msg);
      if (!res.simulated) {
        sentLog.sent_leads[key] = {
          cnpj: lead.osc?.cnpj,
          nome: lead.osc?.nome,
          uf: lead.osc?.uf,
          municipio: lead.osc?.municipio,
          edital_id: lead.edital_id,
          edital_valor: lead.edital_valor,
          score: lead.score,
          phone,
          phone_type: phoneType,
          sent_at: new Date().toISOString(),
          mode: USE_TWO_STEP_OPENER ? 'two_step_opener' : 'full_pitch'
        };
        alreadyContactedPhones.add(phone);
      }

      if (i < eligible.length - 1 && !res.simulated) {
        const waitMs = 70000 + Math.floor(Math.random() * 50000);
        console.log(`   ⏳ Aguardando ${Math.round(waitMs / 1000)}s para simular cadência humana...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    } catch (err: any) {
      console.error(`   ❌ Falha ao enviar para ${lead.osc?.nome}:`, err.message);
      if (/\b(401|403|429)\b/.test(err.message)) {
        console.error('🛑 Erro de autenticação/restrição/rate-limit detectado. Interrompendo lote para proteger a conta.');
        break;
      }
    }
  }

  sentLog.last_run_at = new Date().toISOString();
  fs.writeFileSync(SENT_LOG_PATH, JSON.stringify(sentLog, null, 2), 'utf-8');
  console.log('✅ Lote de horário comercial finalizado.');
}

run();
