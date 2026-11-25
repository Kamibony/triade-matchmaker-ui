import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const LEADS_PATH = path.join(process.cwd(), 'src', 'data', 'diagnostico_campaign_leads.json');
const LOG_PATH = path.join(process.cwd(), 'src', 'data', 'diagnostico_sent_log.json');

const VERCEL_SEND_ENDPOINT =
  process.env.VERCEL_WA_SEND_URL || 'https://triade-matchmaker-ui.vercel.app/api/whatsapp/send';
const MAX_MESSAGES = Math.max(1, parseInt(process.env.MAX_MESSAGES || '7', 10));
const MAX_DAILY = Math.max(1, parseInt(process.env.MAX_DAILY || '25', 10));
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
  variant?: 'A' | 'B';
}

interface SentLogEntry {
  ref: string;
  lote?: number;
  variant?: 'A' | 'B';
  cnpj: string;
  nome: string;
  phone: string;
  tema?: string;
  campanha_tag?: string;
  status: 'sent' | 'blocked_opt_out' | 'not_on_whatsapp' | 'failed';
  provider?: string;
  messageId?: string;
  error?: string;
  sentAt: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBrasiliaDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value || '';
  const m = parts.find((p) => p.type === 'month')?.value || '';
  const d = parts.find((p) => p.type === 'day')?.value || '';
  return `${y}-${m}-${d}`;
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
    dateKey: getBrasiliaDateKey(now),
    formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} BRT (${map.weekday || ''})`
  };
}

async function run() {
  const timeInfo = getBrasiliaTimeInfo();
  console.log(`Diagnostico Pilot Dispatcher started at ${timeInfo.formattedTime} [${timeInfo.dateKey}]`);
  console.log(
    `Config: MAX_MESSAGES=${MAX_MESSAGES}, MAX_DAILY=${MAX_DAILY}, TARGET_LOTE=${TARGET_LOTE || 'any'}, DRY_RUN=${DRY_RUN}, FORCE_SEND=${FORCE_SEND}`
  );

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

  const sentTodayCount = sentLog.filter(
    (e) => e.status === 'sent' && e.sentAt && getBrasiliaDateKey(new Date(e.sentAt)) === timeInfo.dateKey
  ).length;
  const remainingToday = Math.max(0, MAX_DAILY - sentTodayCount);

  if (remainingToday === 0) {
    console.log(`Limite diário atingido hoje (${sentTodayCount}/${MAX_DAILY} enviados em ${timeInfo.dateKey}). Aguardando amanhã.`);
    return;
  }

  const terminalStatuses = new Set(['sent', 'blocked_opt_out', 'not_on_whatsapp']);
  const alreadyDoneCnpjs = new Set(sentLog.filter((e) => terminalStatuses.has(e.status)).map((e) => e.cnpj));
  const alreadyDonePhones = new Set(sentLog.filter((e) => terminalStatuses.has(e.status)).map((e) => e.phone));

  const pending = leads.filter((l) => {
    if (alreadyDoneCnpjs.has(l.cnpj) || alreadyDonePhones.has(l.phone)) return false;
    if (TARGET_LOTE && String(l.lote || '') !== TARGET_LOTE) return false;
    return true;
  });

  const waveLimit = Math.min(MAX_MESSAGES, remainingToday);
  const batch = pending.slice(0, waveLimit);
  console.log(
    `Total leads: ${leads.length} | Already done: ${alreadyDoneCnpjs.size} | Sent today: ${sentTodayCount}/${MAX_DAILY} | Pending: ${pending.length} | This wave: ${batch.length}`
  );

  if (batch.length === 0) {
    console.log('Nenhum lead pendente para este lote. Tudo pronto!');
    return;
  }

  let sentCount = 0;
  let blockedCount = 0;
  let notOnWaCount = 0;
  let failedCount = 0;
  let abortedDueToAuth = false;

  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    const variantTag = lead.variant ? ` [v${lead.variant}]` : '';
    console.log(
      `\n[${i + 1}/${batch.length}] ${lead.ref}${variantTag} (${lead.tema || 'OSC'}) — ${lead.nome} (${lead.municipio}/${lead.uf}) -> +${lead.phone}`
    );

    if (DRY_RUN) {
      console.log('   🧪 DRY_RUN ativo: nenhuma mensagem enviada.');
      continue;
    }

    let didSendRealMessage = false;

    try {
      const res = await fetch(VERCEL_SEND_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'diagnostico',
          phone: lead.phone,
          diagnosticoLead: lead,
          validateBeforeSend: true,
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
          variant: lead.variant,
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
      } else if (data?.notOnWhatsApp) {
        notOnWaCount++;
        console.log(`   📵 Sem WhatsApp ativo: ${data.error || 'invalid'} (pulado sem gastar cota)`);
        sentLog.push({
          ref: lead.ref,
          lote: lead.lote,
          variant: lead.variant,
          cnpj: lead.cnpj,
          nome: lead.nome,
          phone: lead.phone,
          tema: lead.tema,
          campanha_tag: lead.campanha_tag,
          status: 'not_on_whatsapp',
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
          variant: lead.variant,
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

        // Fail-fast: se o canal Whapi perdeu autorização (QR/INIT) ou foi bloqueado/banido, encerra imediatamente
        if (/need channel authorization|unauthorized|not authorized|banned|disconnected|channel.*error/i.test(errMsg)) {
          await fs.writeFile(LOG_PATH, JSON.stringify(sentLog, null, 2) + '\n');
          console.error('\n🛑 FAIL-FAST: Canal Whapi sem autorização ou banido. Encerrando onda imediatamente para evitar erros repetidos.');
          abortedDueToAuth = true;
          break;
        }
      } else {
        sentCount++;
        didSendRealMessage = true;
        console.log(`   ✅ Enviado via ${data.provider} para +${data.phone || lead.phone} (id: ${data.messageId || 'ok'})`);
        sentLog.push({
          ref: lead.ref,
          lote: lead.lote,
          variant: lead.variant,
          cnpj: lead.cnpj,
          nome: lead.nome,
          phone: data.phone || lead.phone,
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
        variant: lead.variant,
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

    // Humanized anti-ban delay (35–65s after real send; short 4–7s pause after skipped invalid number)
    if (i < batch.length - 1) {
      const delayMs = didSendRealMessage
        ? 35_000 + Math.floor(Math.random() * 30_000)
        : 4_000 + Math.floor(Math.random() * 3_000);
      console.log(`   ⏳ Aguardando ${(delayMs / 1000).toFixed(1)}s antes do próximo contato...`);
      await sleep(delayMs);
    }
  }

  console.log(
    `\nResumo do lote: sent=${sentCount}, not_on_whatsapp=${notOnWaCount}, blocked_opt_out=${blockedCount}, failed=${failedCount}${abortedDueToAuth ? ' (ABORTED: channel auth)' : ''}`
  );
}

run().catch((err) => {
  console.error('Fatal error in diagnostico-pilot-dispatcher:', err);
  process.exit(1);
});
