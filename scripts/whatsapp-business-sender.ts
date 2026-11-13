import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const LEADS_PATH = path.resolve('src/data/daily_outbound_leads.json');
const SENT_LOG_PATH = path.resolve('src/data/whatsapp_sent_log.json');

const MAX_MESSAGES_PER_RUN = parseInt(process.env.MAX_MESSAGES_PER_RUN || '6', 10);
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '80', 10);
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
  const apiUrl = (process.env.WHATSAPP_API_URL || '').replace(/\/+$/, '');
  const apiToken = process.env.WHATSAPP_API_TOKEN || '';
  const provider = (process.env.WHATSAPP_PROVIDER || 'evolution').toLowerCase();
  const instanceId = process.env.WHATSAPP_INSTANCE_ID || 'triade';

  if (!apiUrl || !apiToken) {
    console.log(`   🧪 [SIMULAÇÃO - Sem WHATSAPP_API_URL] Mensagem preparada para +${phone}: "${text.slice(0, 80)}..."`);
    return { ok: true, simulated: true };
  }

  if (provider === 'zapi' || apiUrl.includes('z-api.io')) {
    const res = await fetch(`${apiUrl}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': apiToken },
      body: JSON.stringify({ phone, message: text, delayTyping: 4 })
    });
    if (!res.ok) throw new Error(`Z-API HTTP ${res.status}`);
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

  const eligible = leads
    .filter(l => {
      const key = `${l.edital_id}_${l.osc?.cnpj}`;
      if (sentLog.sent_leads[key]) return false;
      if ((l.score || 0) < MIN_SCORE) return false;
      if (l.dias_restantes !== null && l.dias_restantes !== undefined && l.dias_restantes < 15) return false;
      const phone = normalizePhone(
        l.contatos_encontrados?.whatsapp ||
          l.osc?.official_contacts?.ddd_telefone_1 ||
          l.osc?.official_contacts?.ddd_telefone_2
      );
      return !!phone;
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MAX_MESSAGES_PER_RUN);

  console.log(`🚀 Encontrados ${eligible.length} leads inéditos (Score >= ${MIN_SCORE}) para envio cadenciado.`);

  for (let i = 0; i < eligible.length; i++) {
    const lead = eligible[i];
    const key = `${lead.edital_id}_${lead.osc?.cnpj}`;
    const phone = normalizePhone(
      lead.contatos_encontrados?.whatsapp ||
        lead.osc?.official_contacts?.ddd_telefone_1 ||
        lead.osc?.official_contacts?.ddd_telefone_2
    )!;
    const msg = USE_TWO_STEP_OPENER ? buildTwoStepOpener(lead) : lead.whatsapp_message;

    console.log(`[${i + 1}/${eligible.length}] Enviando para ${lead.osc?.nome} (+${phone}) - Score ${lead.score}%...`);
    try {
      const res = await sendViaGateway(phone, msg);
      if (!res.simulated) {
        sentLog.sent_leads[key] = {
          cnpj: lead.osc?.cnpj,
          nome: lead.osc?.nome,
          edital_id: lead.edital_id,
          phone,
          sent_at: new Date().toISOString(),
          mode: USE_TWO_STEP_OPENER ? 'two_step_opener' : 'full_pitch'
        };
      }

      // Humanized delay between messages (45 to 75 seconds in CI)
      if (i < eligible.length - 1 && !res.simulated) {
        const waitMs = 45000 + Math.floor(Math.random() * 30000);
        console.log(`   ⏳ Aguardando ${Math.round(waitMs / 1000)}s para simular cadência humana...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    } catch (err: any) {
      console.error(`   ❌ Falha ao enviar para ${lead.osc?.nome}:`, err.message);
    }
  }

  sentLog.last_run_at = new Date().toISOString();
  fs.writeFileSync(SENT_LOG_PATH, JSON.stringify(sentLog, null, 2), 'utf-8');
  console.log('✅ Lote de horário comercial finalizado.');
}

run();
