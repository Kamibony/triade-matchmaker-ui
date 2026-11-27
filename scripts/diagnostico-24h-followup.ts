import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

const LEADS_PATH = path.join(process.cwd(), 'src', 'data', 'diagnostico_campaign_leads.json');
const FOLLOWUP_LOG_PATH = path.join(process.cwd(), 'src', 'data', 'diagnostico_followup_log.json');

const WHATSAPP_LOG_SHEET_ID =
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '1okK96biPmEpSwxFYFakvjfdfaFJ6tM5DKE9A_64DMAU';
const DIAGNOSTICO_SHEET_ID =
  process.env.OSC_DIAGNOSTICO_SHEET_ID || '1pmzsT6MIkiLfoHCRyosWNs6PH5dKEV3ibMgJMod7ZOg';
const VERCEL_SEND_ENDPOINT =
  process.env.VERCEL_WA_SEND_URL || 'https://triade-matchmaker-ui.vercel.app/api/whatsapp/send';
const BASE_DIAGNOSTICO_URL =
  process.env.DIAGNOSTICO_BASE_URL || 'https://triade-matchmaker-ui.vercel.app';

const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const MIN_HOURS_SINCE_SIM = Math.max(0, parseFloat(process.env.MIN_HOURS_SINCE_SIM || '2'));
const MAX_HOURS_SINCE_INBOUND = Math.min(23.5, Math.max(1, parseFloat(process.env.MAX_HOURS_SINCE_INBOUND || '23')));
const MAX_MESSAGES = Math.max(1, parseInt(process.env.MAX_MESSAGES || '30', 10));

interface CampaignLead {
  ref: string;
  lote?: number;
  cnpj: string;
  nome: string;
  phone: string;
  uf?: string;
  municipio?: string;
  tema?: string;
  campanha_tag?: string;
  origem?: 'Lista' | 'Indicacao' | 'Organico';
  variant?: 'A' | 'B';
}

interface FollowupLogEntry {
  ref: string;
  cnpj: string;
  nome: string;
  phone: string;
  simAtBrt: string;
  status: 'sent' | 'blocked_opt_out' | 'failed';
  provider?: string;
  messageId?: string;
  error?: string;
  sentAt: string;
}

const PT_LOWERCASE_WORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'nas', 'nos',
  'a', 'o', 'as', 'os', 'com', 'para', 'por', 'ao', 'aos', 'às'
]);

const PT_ACCENT_MAP: Record<string, string> = {
  associacao: 'Associação',
  associacoes: 'Associações',
  federacao: 'Federação',
  organizacao: 'Organização',
  fundacao: 'Fundação',
  uniao: 'União',
  protecao: 'Proteção',
  municipio: 'Município',
  indigena: 'Indígena',
  agricola: 'Agrícola',
  amazonia: 'Amazônia',
  sao: 'São',
  antonio: 'Antônio',
  mae: 'Mãe',
  comunitaria: 'Comunitária',
  comunitario: 'Comunitário',
  educacao: 'Educação',
  saude: 'Saúde',
  assistencia: 'Assistência',
  infancia: 'Infância',
  promocao: 'Promoção',
  integracao: 'Integração',
  acao: 'Ação',
  preservacao: 'Preservação',
  instituicao: 'Instituição',
  regiao: 'Região',
  solidaria: 'Solidária',
  solidarios: 'Solidários',
  solidario: 'Solidário',
  inclusao: 'Inclusão',
  deficiencia: 'Deficiência',
  referencia: 'Referência',
  joao: 'João',
  jose: 'José',
  colonia: 'Colônia',
  celia: 'Célia'
};

const KNOWN_ACRONYMS = new Set([
  'ONG', 'OSC', 'AM', 'IAS', 'ISNB', 'APRA', 'CMULHER', 'ACPRSJ', 'IDECOVIM', 'PCD'
]);

function normalizePhoneDigits(raw: string | null | undefined): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  return `55${digits}`;
}

function normalizeCnpj(raw: string | null | undefined): string {
  return String(raw || '').replace(/\D/g, '');
}

function humanizeOrgName(rawName: string | null | undefined): string {
  let clean = String(rawName || '')
    .replace(/([A-Za-zÀ-ÿ])-([A-Za-zÀ-ÿ])/g, '$1 - $2')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*$/g, '')
    .trim();
  if (!clean) return 'sua organização';

  if (clean.length > 42) {
    clean = clean
      .replace(/\s+(NO|DO)\s+ESTADO\s+DO\s+AMAZONAS(\s*-\s*AM)?$/i, '')
      .replace(/\s+DO\s+MUNICIPIO\s+DE\s+[^-]+$/i, '')
      .replace(/\s*-\s*(AM|AMAZONAS)$/i, '')
      .replace(/\s*-\s*$/g, '')
      .trim();
  }

  const words = clean.split(' ').map((word, idx) => {
    const bare = word.replace(/[^A-Za-zÀ-ÿ0-9-]/g, '');
    if (KNOWN_ACRONYMS.has(bare.toUpperCase())) return word.toUpperCase();
    const lower = word
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (idx > 0 && PT_LOWERCASE_WORDS.has(lower)) return lower;
    if (PT_ACCENT_MAP[lower]) return PT_ACCENT_MAP[lower];
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  let result = words.join(' ').trim();
  if (result.length > 46) {
    const truncated = result.slice(0, 46).replace(/\s+\S*$/, '').trim();
    result = truncated.replace(/\s+(de|da|do|das|dos|e|em|na|no|para|por|com|-)$/i, '').trim();
  }
  return result || 'sua organização';
}

function getOrgArticle(orgName: string): 'do' | 'da' {
  const firstWord = orgName
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (
    /^(instituto|centro|conselho|movimento|sindicato|grupo|projeto|forum|fundo|nucleo|coletivo|clube|observatorio|comite|espaco|programa|sistema|servicos|servico|dojo)$/.test(
      firstWord
    )
  ) {
    return 'do';
  }
  return 'da';
}

function buildDiagnosticoUrl(lead: CampaignLead): string {
  const cleanBase = BASE_DIAGNOSTICO_URL.replace(/\/+$/, '');
  const params = new URLSearchParams();
  const cleanCnpj = normalizeCnpj(lead.cnpj);
  if (cleanCnpj.length === 14) params.set('cnpj', cleanCnpj);
  params.set('origem', lead.origem || 'Lista');
  if (lead.campanha_tag) params.set('campanha', lead.campanha_tag);
  if (lead.ref) params.set('ref', lead.ref);
  return `${cleanBase}/diagnostico?${params.toString()}`;
}

function buildFollowupMessage(lead: CampaignLead): string {
  const orgName = humanizeOrgName(lead.nome);
  const orgArt = getOrgArticle(orgName);
  const url = buildDiagnosticoUrl(lead);

  return (
    `Bom dia, pessoal ${orgArt} ${orgName}! 😊\n\n` +
    `Passando só para deixar fácil o acesso ao diagnóstico gratuito que vocês solicitaram ontem — leva cerca de 3 minutinhos e já mostra na hora os editais abertos compatíveis com a instituição:\n\n` +
    `${url}\n\n` +
    `Se tiverem qualquer dúvida no preenchimento, podem responder por aqui mesmo!`
  );
}

/**
 * Parses timestamps formatted as "DD/MM/YYYY, HH:mm:ss" in America/Sao_Paulo (UTC-3).
 */
function parseBrtTimestamp(raw: string | null | undefined): Date | null {
  const m = String(raw || '')
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss = '00'] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}-03:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getGoogleAuth() {
  const credsEnv = (process.env.GCP_DRIVE_CREDENTIALS || '').trim();
  if (!credsEnv) {
    throw new Error('GCP_DRIVE_CREDENTIALS não configurado.');
  }
  const credentials = JSON.parse(credsEnv);
  if (credentials.refreshToken && credentials.clientId && credentials.clientSecret) {
    const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    auth.setCredentials({ refresh_token: credentials.refreshToken });
    return auth;
  }
  if (credentials.private_key && credentials.client_email) {
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
  }
  throw new Error('Formato de GCP_DRIVE_CREDENTIALS inválido.');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const now = new Date();
  const brtNow = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(now);

  console.log(`Diagnostico 24h Free-Window Follow-Up started at ${brtNow} BRT`);
  console.log(
    `Config: DRY_RUN=${DRY_RUN}, MIN_HOURS_SINCE_SIM=${MIN_HOURS_SINCE_SIM}h, MAX_HOURS_SINCE_INBOUND=${MAX_HOURS_SINCE_INBOUND}h, MAX_MESSAGES=${MAX_MESSAGES}`
  );

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const [leadsRaw, followupLogRaw, waLogRes, optOutRes, qualifiedRes] = await Promise.all([
    fs.readFile(LEADS_PATH, 'utf-8'),
    fs.readFile(FOLLOWUP_LOG_PATH, 'utf-8').catch(() => '[]'),
    sheets.spreadsheets.values.get({
      spreadsheetId: WHATSAPP_LOG_SHEET_ID,
      range: 'WhatsApp_Log!A2:H1000'
    }),
    sheets.spreadsheets.values
      .get({
        spreadsheetId: WHATSAPP_LOG_SHEET_ID,
        range: 'Opt_Out!A2:C1000'
      })
      .catch(() => ({ data: { values: [] } })),
    sheets.spreadsheets.values.get({
      spreadsheetId: DIAGNOSTICO_SHEET_ID,
      range: 'OSCs_Qualificadas!A2:C1000'
    })
  ]);

  const leads: CampaignLead[] = JSON.parse(leadsRaw);
  const followupLog: FollowupLogEntry[] = JSON.parse(followupLogRaw);

  // Build completed CNPJs set from OSCs_Qualificadas
  const completedCnpjs = new Set<string>();
  for (const row of qualifiedRes.data.values || []) {
    const cnpj = normalizeCnpj(row[1]);
    if (cnpj.length === 14) completedCnpjs.add(cnpj);
  }

  // Build Opt_Out phone set (both full normalized and last 8 digits)
  const optedOutLast8 = new Set<string>();
  for (const row of optOutRes.data.values || []) {
    const phone = normalizePhoneDigits(row[0] || row[1]);
    if (phone.length >= 10) optedOutLast8.add(phone.slice(-8));
  }

  // Build already-nudged sets from diagnostico_followup_log.json
  const alreadyNudgedCnpjs = new Set(
    followupLog.filter((e) => e.status === 'sent' || e.status === 'blocked_opt_out').map((e) => normalizeCnpj(e.cnpj))
  );
  const alreadyNudgedLast8 = new Set(
    followupLog
      .filter((e) => e.status === 'sent' || e.status === 'blocked_opt_out')
      .map((e) => normalizePhoneDigits(e.phone).slice(-8))
      .filter(Boolean)
  );

  // Parse WhatsApp_Log for diagnostico_sim, latest inbound timestamp, and opt_out events
  const simByLast8 = new Map<string, { phone: string; simDate: Date; simAtBrt: string }>();
  const latestInboundByLast8 = new Map<string, Date>();

  for (const row of waLogRes.data.values || []) {
    const tsRaw = String(row[0] || '').trim();
    const status = String(row[1] || '').trim().toLowerCase();
    const phone = normalizePhoneDigits(row[2]);
    const intent = String(row[5] || '').trim().toLowerCase();
    if (!phone) continue;

    const last8 = phone.slice(-8);
    const parsedDate = parseBrtTimestamp(tsRaw);

    if (status === 'opt_out' || intent === 'diagnostico_nao') {
      optedOutLast8.add(last8);
    }

    if (parsedDate) {
      const prevLatest = latestInboundByLast8.get(last8);
      if (!prevLatest || parsedDate > prevLatest) {
        latestInboundByLast8.set(last8, parsedDate);
      }
    }

    if (intent === 'diagnostico_sim' && status === 'processed' && parsedDate) {
      const prevSim = simByLast8.get(last8);
      if (!prevSim || parsedDate > prevSim.simDate) {
        simByLast8.set(last8, { phone, simDate: parsedDate, simAtBrt: tsRaw });
      }
    }
  }

  // Match static leads by phone last 8 digits
  const leadByLast8 = new Map<string, CampaignLead>();
  for (const lead of leads) {
    const norm = normalizePhoneDigits(lead.phone);
    if (norm) leadByLast8.set(norm.slice(-8), { ...lead, phone: norm });
  }

  const eligible: Array<{
    lead: CampaignLead;
    simAtBrt: string;
    hoursSinceSim: number;
    hoursSinceInbound: number;
  }> = [];

  let skippedCompleted = 0;
  let skippedOptOut = 0;
  let skippedAlreadyNudged = 0;
  let skippedOutsideWindow = 0;
  let skippedTooRecent = 0;
  let skippedUnknownLead = 0;

  for (const [last8, simInfo] of simByLast8.entries()) {
    const lead = leadByLast8.get(last8);
    if (!lead) {
      skippedUnknownLead++;
      continue;
    }

    const cleanCnpj = normalizeCnpj(lead.cnpj);
    if (completedCnpjs.has(cleanCnpj)) {
      skippedCompleted++;
      console.log(`⏭️  ${lead.ref} (${humanizeOrgName(lead.nome)}) — já concluiu o /diagnostico.`);
      continue;
    }

    if (optedOutLast8.has(last8)) {
      skippedOptOut++;
      console.log(`🛑 ${lead.ref} (${humanizeOrgName(lead.nome)}) — está em Opt-Out.`);
      continue;
    }

    if (alreadyNudgedCnpjs.has(cleanCnpj) || alreadyNudgedLast8.has(last8)) {
      skippedAlreadyNudged++;
      console.log(`⏭️  ${lead.ref} (${humanizeOrgName(lead.nome)}) — lembrete já enviado anteriormente.`);
      continue;
    }

    const latestInbound = latestInboundByLast8.get(last8) || simInfo.simDate;
    const hoursSinceSim = (now.getTime() - simInfo.simDate.getTime()) / (1000 * 60 * 60);
    const hoursSinceInbound = (now.getTime() - latestInbound.getTime()) / (1000 * 60 * 60);

    if (hoursSinceInbound > MAX_HOURS_SINCE_INBOUND) {
      skippedOutsideWindow++;
      console.log(
        `⌛ ${lead.ref} (${humanizeOrgName(lead.nome)}) — janela gratuita de 24h expirada (${hoursSinceInbound.toFixed(1)}h). Pulado para manter custo R$ 0.`
      );
      continue;
    }

    if (hoursSinceSim < MIN_HOURS_SINCE_SIM) {
      skippedTooRecent++;
      console.log(
        `🕒 ${lead.ref} (${humanizeOrgName(lead.nome)}) — clicou Sim há apenas ${hoursSinceSim.toFixed(1)}h (mínimo ${MIN_HOURS_SINCE_SIM}h).`
      );
      continue;
    }

    eligible.push({
      lead,
      simAtBrt: simInfo.simAtBrt,
      hoursSinceSim,
      hoursSinceInbound
    });
  }

  eligible.sort((a, b) => b.hoursSinceInbound - a.hoursSinceInbound);
  const batch = eligible.slice(0, MAX_MESSAGES);

  console.log('\n📊 Resumo da triagem:');
  console.log(`   - Total "Sim" no WhatsApp_Log: ${simByLast8.size}`);
  console.log(`   - Já concluíram /diagnostico: ${skippedCompleted}`);
  console.log(`   - Opt-Out: ${skippedOptOut} | Já receberam lembrete: ${skippedAlreadyNudged}`);
  console.log(`   - Fora da janela 24h: ${skippedOutsideWindow} | Muito recente (<${MIN_HOURS_SINCE_SIM}h): ${skippedTooRecent} | Fora da lista: ${skippedUnknownLead}`);
  console.log(`   - ✅ Elegíveis para lembrete GRATUITO agora: ${batch.length}`);

  if (batch.length === 0) {
    console.log('\nNenhum lead pendente dentro da janela gratuita de 24h. Encerrando.');
    return;
  }

  let sentCount = 0;
  let blockedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    const { lead } = item;
    const message = buildFollowupMessage(lead);

    console.log(
      `\n[${i + 1}/${batch.length}] ${lead.ref} — ${humanizeOrgName(lead.nome)} (+${lead.phone}) | Sim em: ${item.simAtBrt} (${item.hoursSinceInbound.toFixed(1)}h atrás)`
    );

    if (DRY_RUN) {
      console.log('   🧪 DRY_RUN ativo. Mensagem que seria enviada (custo R$ 0,00):');
      console.log('   ---');
      console.log(
        message
          .split('\n')
          .map((line) => `   ${line}`)
          .join('\n')
      );
      console.log('   ---');
      continue;
    }

    try {
      const res = await fetch(VERCEL_SEND_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'diagnostico',
          phone: lead.phone,
          message,
          diagnosticoLead: lead,
          validateBeforeSend: false,
          enforceBusinessHours: false,
          forceSendOutsideHours: true
        })
      });

      const data = await res.json().catch(() => ({}));

      if (data?.blockedByOptOut) {
        blockedCount++;
        console.log(`   🛑 Bloqueado por Opt-Out no gateway: ${data.error || 'Opt-Out'}`);
        followupLog.push({
          ref: lead.ref,
          cnpj: normalizeCnpj(lead.cnpj),
          nome: lead.nome,
          phone: lead.phone,
          simAtBrt: item.simAtBrt,
          status: 'blocked_opt_out',
          provider: data.provider,
          error: data.error,
          sentAt: new Date().toISOString()
        });
      } else if (res.ok && data?.ok) {
        sentCount++;
        console.log(`   ✅ Lembrete gratuito enviado via ${data.provider || 'meta'} (id: ${data.messageId || 'n/a'})`);
        followupLog.push({
          ref: lead.ref,
          cnpj: normalizeCnpj(lead.cnpj),
          nome: lead.nome,
          phone: lead.phone,
          simAtBrt: item.simAtBrt,
          status: 'sent',
          provider: data.provider,
          messageId: data.messageId,
          sentAt: new Date().toISOString()
        });
      } else {
        failedCount++;
        const errMsg = data?.error || `HTTP ${res.status}`;
        console.log(`   ❌ Falha ao enviar: ${errMsg}`);
        followupLog.push({
          ref: lead.ref,
          cnpj: normalizeCnpj(lead.cnpj),
          nome: lead.nome,
          phone: lead.phone,
          simAtBrt: item.simAtBrt,
          status: 'failed',
          provider: data?.provider,
          error: errMsg,
          sentAt: new Date().toISOString()
        });
      }

      await fs.writeFile(FOLLOWUP_LOG_PATH, JSON.stringify(followupLog, null, 2) + '\n', 'utf-8');
    } catch (err: any) {
      failedCount++;
      console.log(`   ❌ Erro de rede: ${err?.message || err}`);
    }

    if (i < batch.length - 1) {
      const delayMs = 8000 + Math.floor(Math.random() * 6000);
      console.log(`   ⏳ Aguardando ${(delayMs / 1000).toFixed(1)}s antes do próximo envio...`);
      await sleep(delayMs);
    }
  }

  console.log(`\n🏁 Finalizado: ${sentCount} enviados (R$ 0,00), ${blockedCount} opt-out, ${failedCount} falhas.`);
}

run().catch((err) => {
  console.error('Fatal error in diagnostico-24h-followup:', err);
  process.exit(1);
});
