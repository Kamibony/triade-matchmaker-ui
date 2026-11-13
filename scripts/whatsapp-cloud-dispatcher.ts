import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const LEADS_PATH = path.join(process.cwd(), 'src', 'data', 'daily_outbound_leads.json');
const LOG_PATH = path.join(process.cwd(), 'src', 'data', 'whatsapp_outreach_log.json');

const VERCEL_SEND_ENDPOINT =
  process.env.VERCEL_WA_SEND_URL || 'https://triade-matchmaker-ui.vercel.app/api/whatsapp/send';
const WHATSAPP_API_TOKEN = (process.env.WHATSAPP_API_TOKEN || '').trim();
const FORCE_SEND = process.env.FORCE_SEND === 'true';
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '25', 10);

interface OutreachLogEntry {
  key: string;
  edital_id: string;
  cnpj: string;
  ong_nome: string;
  phone: string;
  phoneType: 'mobile' | 'landline' | 'unknown';
  score: number;
  provider: string;
  messageId?: string;
  status: 'sent' | 'failed';
  error?: string;
  sentAt: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBrazilPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.toString().replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  return `55${digits}`;
}

function classifyBrazilPhoneType(raw: string | null | undefined): 'mobile' | 'landline' | 'unknown' {
  const norm = normalizeBrazilPhone(raw);
  if (!norm || norm.length < 12) return 'unknown';
  const local = norm.slice(4);
  if (local.length === 9 && local.startsWith('9')) return 'mobile';
  if (local.length === 8 && (local.startsWith('8') || local.startsWith('9') || local.startsWith('7'))) {
    return 'mobile';
  }
  return 'landline';
}

function getBrasiliaTimeInfo(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const hour = parseInt(map.hour || '0', 10);
  const minute = parseInt(map.minute || '0', 10);
  const weekdayStr = (map.weekday || '').toLowerCase();
  const isWeekend = weekdayStr.includes('sáb') || weekdayStr.includes('sab') || weekdayStr.includes('dom');
  const decimalHour = hour + minute / 60;
  const isBusinessHours = !isWeekend && decimalHour >= 9.0 && decimalHour <= 17.5;

  return {
    isBusinessHours,
    formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} BRT (${map.weekday || ''})`
  };
}

function formatCurrency(val: number | null | undefined): string {
  if (!val) return 'valor expressivo';
  if (val >= 1000000) return `R$ ${(val / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (val >= 1000) return `R$ ${(val / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function buildTwoStepOpenerMessage(lead: any): string {
  const valorStr = lead.edital_valor ? formatCurrency(lead.edital_valor) : 'valor expressivo';
  return `Olá, pessoal da ${lead.osc?.nome}, tudo bem? Aqui é da equipe da Maria Angela, da Triade Captação de Recursos. Vimos a atuação de vocês em ${lead.osc?.municipio} e mapeamos um edital aberto de até ${valorStr} muito alinhado ao perfil da instituição. Posso enviar um resumo rápido por aqui?`;
}

async function sendDirectViaWhapi(phone: string, text: string) {
  const res = await fetch('https://gate.whapi.cloud/messages/text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_API_TOKEN}`
    },
    body: JSON.stringify({
      to: `${phone}@s.whatsapp.net`,
      body: text,
      typing_time: 3
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.message || `Whapi HTTP ${res.status}`);
  }
  return {
    provider: 'whapi-direct',
    messageId: data?.message?.id || data?.id
  };
}

async function sendViaVercelGateway(lead: any, phone: string, text: string) {
  const res = await fetch(VERCEL_SEND_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      message: text,
      lead,
      useTwoStepOpener: false,
      enforceBusinessHours: !FORCE_SEND,
      forceSendOutsideHours: FORCE_SEND
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `Vercel Gateway HTTP ${res.status}`);
  }
  if (data.simulated) {
    throw new Error(
      'Vercel gateway está em modo simulação. Adicione WHATSAPP_API_TOKEN nas Environment Variables da Vercel (ou nos GitHub Secrets) e faça Redeploy.'
    );
  }
  return {
    provider: data.provider || 'vercel-gateway',
    messageId: data.messageId
  };
}

async function run() {
  const timeInfo = getBrasiliaTimeInfo();
  console.log(`Cloud WhatsApp Auto-Dispatcher started at ${timeInfo.formattedTime}`);

  if (!timeInfo.isBusinessHours && !FORCE_SEND) {
    console.log(`Outside business hours (Mon–Fri 09:00–17:30 BRT). Exiting cleanly until next scheduled window.`);
    return;
  }

  let leads: any[] = [];
  try {
    const raw = await fs.readFile(LEADS_PATH, 'utf-8');
    leads = JSON.parse(raw);
  } catch (e: any) {
    console.error(`Failed to read ${LEADS_PATH}:`, e.message);
    return;
  }

  let logs: OutreachLogEntry[] = [];
  try {
    const rawLogs = await fs.readFile(LOG_PATH, 'utf-8');
    logs = JSON.parse(rawLogs);
  } catch {
    logs = [];
  }

  const alreadyContactedKeys = new Set(
    logs.filter((l) => l.status === 'sent').map((l) => l.key)
  );
  const alreadyContactedPhones = new Set(
    logs.filter((l) => l.status === 'sent').map((l) => l.phone)
  );

  const candidates = leads
    .filter((l) => l && l.score > 0 && l.motivo_match !== 'Failed')
    .map((lead) => {
      const rawPhone =
        lead.contatos_encontrados?.whatsapp ||
        lead.osc?.official_contacts?.ddd_telefone_1 ||
        lead.osc?.official_contacts?.ddd_telefone_2;
      const phone = normalizeBrazilPhone(rawPhone);
      const phoneType = classifyBrazilPhoneType(rawPhone);
      const key = `${lead.edital_id}_${lead.osc?.cnpj}`;
      return { lead, phone, phoneType, key };
    })
    .filter((c) => {
      if (!c.phone) return false;
      if (alreadyContactedKeys.has(c.key) || alreadyContactedPhones.has(c.phone)) return false;
      return true;
    })
    .sort((a, b) => {
      const mA = a.phoneType === 'mobile' ? 1 : 0;
      const mB = b.phoneType === 'mobile' ? 1 : 0;
      if (mA !== mB) return mB - mA;
      return (b.lead.score || 0) - (a.lead.score || 0);
    })
    .slice(0, MAX_PER_RUN);

  console.log(`Found ${candidates.length} new eligible leads to contact (Max ${MAX_PER_RUN} per run).`);
  if (candidates.length === 0) return;

  let sentCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    const { lead, phone, phoneType, key } = candidates[i];
    if (!phone) continue;

    const messageText = buildTwoStepOpenerMessage(lead);
    console.log(`[${i + 1}/${candidates.length}] Sending to ${lead.osc?.nome} (+${phone}, ${phoneType})...`);

    try {
      const res = WHATSAPP_API_TOKEN
        ? await sendDirectViaWhapi(phone, messageText)
        : await sendViaVercelGateway(lead, phone, messageText);

      logs.push({
        key,
        edital_id: String(lead.edital_id),
        cnpj: String(lead.osc?.cnpj || ''),
        ong_nome: String(lead.osc?.nome || ''),
        phone,
        phoneType,
        score: Number(lead.score || 0),
        provider: res.provider,
        messageId: res.messageId,
        status: 'sent',
        sentAt: new Date().toISOString()
      });
      alreadyContactedPhones.add(phone);
      sentCount++;
      console.log(`  -> Sent successfully via ${res.provider} (ID: ${res.messageId || 'n/a'})`);
    } catch (err: any) {
      console.error(`  -> Failed: ${err.message}`);
      logs.push({
        key,
        edital_id: String(lead.edital_id),
        cnpj: String(lead.osc?.cnpj || ''),
        ong_nome: String(lead.osc?.nome || ''),
        phone,
        phoneType,
        score: Number(lead.score || 0),
        provider: WHATSAPP_API_TOKEN ? 'whapi-direct' : 'vercel-gateway',
        status: 'failed',
        error: err.message,
        sentAt: new Date().toISOString()
      });
      if (err.message.includes('modo simulação')) {
        console.error('Stopping batch because gateway is in simulation mode.');
        break;
      }
    }

    if (i < candidates.length - 1) {
      // Human-like 35-65s cadence between messages
      const waitMs = 35000 + Math.floor(Math.random() * 30000);
      console.log(`  Waiting ${Math.round(waitMs / 1000)}s before next message...`);
      await sleep(waitMs);
    }
  }

  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.writeFile(LOG_PATH, JSON.stringify(logs, null, 2), 'utf-8');
  console.log(`\nCloud dispatch finished. Sent: ${sentCount}/${candidates.length}.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
