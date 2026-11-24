import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const LEADS_PATH = path.join(process.cwd(), 'src', 'data', 'diagnostico_campaign_leads.json');
const LOG_PATH = path.join(process.cwd(), 'src', 'data', 'diagnostico_sent_log.json');

const VERCEL_SEND_ENDPOINT =
  process.env.VERCEL_WA_SEND_URL || 'https://triade-matchmaker-ui.vercel.app/api/whatsapp/send';
const MAX_MESSAGES = Math.max(1, parseInt(process.env.MAX_MESSAGES || '15', 10));
const TARGET_LOTE = (process.env.TARGET_LOTE || '').trim();
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const FORCE_SEND = (process.env.FORCE_SEND || 'false').toLowerCase() === 'true';

interface CampaignLead {
  ref: string;
  lote?: number;
  cnpj: string;
  nome: string;
  phone: string;
  uf?: string;
  municipio?: string;
  tema?: string;
  idade_anos?: number;
  campanha_tag?: string;
  origem?: 'Lista' | 'Indicacao' | 'Organico';
}

interface SentLogEntry {
  ref: string;
  lote?: number;
  cnpj: string;
  nome: string;
  phone: string;
  tema?: string;
  campanha_tag?: string;
  status: 'sent' | 'blocked_opt_out' | 'failed';
  provider?: string;
  messageId?: string;
  error?: string;
  sentAt: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const weekday = (map.weekday || '').toLowerCase();
  const isWeekend = weekday.includes('sáb') || weekday.includes('sab') || weekday.includes('dom');
  const decimal = hour + minute / 60;
  const isBusinessHours = !isWeekend && decimal >= 9.0 && decimal <= 17.5;

  return {
    isBusinessHours,
    formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} BRT (${map.weekday || ''})`
  };
}

async function run() {
  const timeInfo = getBrasiliaTimeInfo();
  console.log(`Diagnostico Pilot Dispatcher started at ${timeInfo.formattedTime}`);
  console.log(`Config: MAX_MESSAGES=${MAX_MESSAGES}, TARGET_LOTE=${TARGET_LOTE || 'any'}, DRY_RUN=${DRY_RUN}, FORCE_SEND=${FORCE_SEND}`);

  if (!timeInfo.isBusinessHours && !FORCE_SEND && !DRY_RUN) {
    console.log('Fora do horário comercial (Seg–Sex, 09:00–17:30 BRT). Encerrando com segurança sem enviar.');
    return;
  }

  const leads: CampaignLead[] = JSON.parse(await fs.readFile(LEADS_PATH, 'utf-8'));
  let sentLog: SentLogEntry[] = [];
  try {
    sentLog = JSON.parse(await fs.readFile(LOG_PATH, 'utf-8'));
  } catch {
    sentLog = [];
  }

  const alreadyDoneCnpjs = new Set(
    sentLog.filter((e) => e.status === 'sent' || e.status === 'blocked_opt_out').map((e) => e.cnpj)
  );
  const alreadyDonePhones = new Set(
    sentLog.filter((e) => e.status === 'sent' || e.status === 'blocked_opt_out').map((e) => e.phone)
  );

  const pending = leads.filter((l) => {
    if (alreadyDoneCnpjs.has(l.cnpj) || alreadyDonePhones.has(l.phone)) return false;
    if (TARGET_LOTE && String(l.lote || '') !== TARGET_LOTE) return false;
    return true;
  });

  const batch = pending.slice(0, MAX_MESSAGES);
  console.log(`Total leads: ${leads.length} | Already done: ${alreadyDoneCnpjs.size} | Pending: ${pending.length} | This batch: ${batch.length}`);

  if (batch.length === 0) {
    console.log('Nenhum lead pendente para este lote. Tudo pronto!');
    return;
  }

  let sentCount = 0;
  let blockedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    console.log(`\n[${i + 1}/${batch.length}] ${lead.ref} (${lead.tema || 'OSC'}) — ${lead.nome} (${lead.municipio}/${lead.uf}) -> +${lead.phone}`);

    if (DRY_RUN) {
      console.log('   🧪 DRY_RUN ativo: nenhuma mensagem enviada.');
      continue;
    }

    try {
      const res = await fetch(VERCEL_SEND_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'diagnostico',
          phone: lead.phone,
          diagnosticoLead: lead,
          enforceBusinessHours: !FORCE_SEND,
          forceSendOutsideHours: FORCE_SEND
        })
      });

      const data = await res.json().catch(() => ({}));

      if (data?.blockedByOptOut) {
        blockedCount++;
        console.log(`   🛑 Bloqueado por Opt-Out: ${data.error || 'Opt-Out'}`);
        sentLog.push({
          ref: lead.ref,
          lote: lead.lote,
          cnpj: lead.cnpj,
          nome: lead.nome,
          phone: lead.phone,
          tema: lead.tema,
          campanha_tag: lead.campanha_tag,
          status: 'blocked_opt_out',
          provider: data.provider,
          error: data.error,
          sentAt: new Date().toISOString()
        });
      } else if (!res.ok || !data?.ok || data?.simulated) {
        const errMsg = data?.simulated
          ? 'Vercel gateway está em modo simulação (WHATSAPP_API_TOKEN ausente).'
          : data?.error || `HTTP ${res.status}`;
        failedCount++;
        console.error(`   ❌ Falha: ${errMsg}`);
        sentLog.push({
          ref: lead.ref,
          lote: lead.lote,
          cnpj: lead.cnpj,
          nome: lead.nome,
          phone: lead.phone,
          tema: lead.tema,
          campanha_tag: lead.campanha_tag,
          status: 'failed',
          provider: data?.provider,
          error: errMsg,
          sentAt: new Date().toISOString()
        });
      } else {
        sentCount++;
        console.log(`   ✅ Enviado via ${data.provider} (id: ${data.messageId || 'ok'})`);
        sentLog.push({
          ref: lead.ref,
          lote: lead.lote,
          cnpj: lead.cnpj,
          nome: lead.nome,
          phone: lead.phone,
          tema: lead.tema,
          campanha_tag: lead.campanha_tag,
          status: 'sent',
          provider: data.provider,
          messageId: data.messageId,
          sentAt: new Date().toISOString()
        });
      }

      // Persist immediately after each send so no duplicate happens if interrupted
      await fs.writeFile(LOG_PATH, JSON.stringify(sentLog, null, 2) + '\n');
    } catch (err: any) {
      failedCount++;
      console.error(`   ❌ Erro de rede: ${err?.message || err}`);
      sentLog.push({
        ref: lead.ref,
        lote: lead.lote,
        cnpj: lead.cnpj,
        nome: lead.nome,
        phone: lead.phone,
        tema: lead.tema,
        campanha_tag: lead.campanha_tag,
        status: 'failed',
        error: err?.message || String(err),
        sentAt: new Date().toISOString()
      });
      await fs.writeFile(LOG_PATH, JSON.stringify(sentLog, null, 2) + '\n');
    }

    // Humanized anti-ban delay (20–35 seconds between messages)
    if (i < batch.length - 1) {
      const delayMs = 20_000 + Math.floor(Math.random() * 15_000);
      console.log(`   ⏳ Aguardando ${(delayMs / 1000).toFixed(1)}s antes do próximo envio...`);
      await sleep(delayMs);
    }
  }

  console.log(`\nResumo do lote: sent=${sentCount}, blocked_opt_out=${blockedCount}, failed=${failedCount}`);
}

run().catch((err) => {
  console.error('Fatal error in diagnostico-pilot-dispatcher:', err);
  process.exit(1);
});
