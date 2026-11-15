import { env } from '$env/dynamic/private';
import { google } from 'googleapis';

const DEFAULT_MONITOR_SHEET_ID = '1okK96biPmEpSwxFYFakvjfdfaFJ6tM5DKE9A_64DMAU';

/**
 * Contatos com bloqueio permanente hardcoded (ex: CESAR Recife +55 81 3419-6700).
 * Nunca devem receber mensagens automáticas ou manuais do sistema.
 */
export const HARD_BLOCKED_PHONES = new Set<string>([
  '558134196700', // CESAR - Bot institucional Finep (exclusão definitiva)
  '8134196700'
]);

const optOutMemoryCache = new Set<string>();
let lastSheetSyncAt = 0;
const SHEET_CACHE_TTL_MS = 30_000;

function normalizeDigits(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 10) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  return `55${digits}`;
}

function getPhoneVariants(raw: string | null | undefined): string[] {
  const norm = normalizeDigits(raw);
  if (!norm) return [];
  const last8 = norm.slice(-8);
  const withoutCountry = norm.startsWith('55') ? norm.slice(2) : norm;
  return Array.from(new Set([norm, withoutCountry, last8].filter(Boolean)));
}

function getGoogleSheetsAuth() {
  const credsEnv = (env.GCP_DRIVE_CREDENTIALS || process.env.GCP_DRIVE_CREDENTIALS || '').trim();
  if (!credsEnv) return null;

  const credentials = JSON.parse(credsEnv);
  if (credentials.refreshToken && credentials.clientId && credentials.clientSecret) {
    const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    auth.setCredentials({ refresh_token: credentials.refreshToken });
    return auth;
  }

  if (credentials.private_key && credentials.client_email) {
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }

  return null;
}

function getBrasiliaTimestamp(): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
}

/**
 * Detecta pedidos claros de descadastro / PARAR nas mensagens recebidas.
 */
export function detectOptOutCommand(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!normalized) return false;

  // Palavra exata ou início direto com comando de saída
  if (/^(parar|pare|stop|sair|cancelar|descadastrar|remover)[\s.!?,;:]*$/i.test(normalized)) {
    return true;
  }
  if (/^parar\b/i.test(normalized)) {
    return true;
  }

  // Frases explícitas pedindo para não mandar mais mensagens
  if (
    /\b(nao quero|nao mandar|nao envie|nao enviar|pare de mandar|parar de mandar|pode parar|favor parar|nao tenho interesse.*parar|tirar.*lista|remover.*lista)\b/i.test(
      normalized
    )
  ) {
    return true;
  }

  return false;
}

async function syncOptOutFromSheet(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSheetSyncAt < SHEET_CACHE_TTL_MS) return;

  try {
    const auth = getGoogleSheetsAuth();
    if (!auth) return;

    const spreadsheetId =
      (env.WHATSAPP_MONITOR_SHEET_ID || process.env.WHATSAPP_MONITOR_SHEET_ID || '').trim() ||
      DEFAULT_MONITOR_SHEET_ID;

    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Opt_Out!B:B'
    });

    const rows = res.data.values || [];
    for (const row of rows) {
      const cell = String(row?.[0] || '').trim();
      if (!cell || cell.toLowerCase().includes('telefone')) continue;
      for (const variant of getPhoneVariants(cell)) {
        optOutMemoryCache.add(variant);
      }
    }
    lastSheetSyncAt = now;
  } catch (err: any) {
    console.warn('[whatsapp-optout] Aviso ao ler aba Opt_Out:', err?.message || err);
  }
}

export async function isPhoneOptedOut(rawPhone: string | null | undefined): Promise<{
  blocked: boolean;
  reason?: string;
}> {
  const variants = getPhoneVariants(rawPhone);
  if (variants.length === 0) return { blocked: false };

  // 1. Checa bloqueio permanente hardcoded (ex: CESAR +55 81 3419-6700)
  for (const v of variants) {
    if (HARD_BLOCKED_PHONES.has(v)) {
      return {
        blocked: true,
        reason: `Contato bloqueado permanentemente (${rawPhone} — exclusão definitiva / CESAR).`
      };
    }
  }

  // 2. Checa cache em memória + sincroniza aba Opt_Out do Google Sheets
  for (const v of variants) {
    if (optOutMemoryCache.has(v)) {
      return {
        blocked: true,
        reason: `Contato em lista Opt-Out / PARAR (${rawPhone}).`
      };
    }
  }

  await syncOptOutFromSheet();
  for (const v of variants) {
    if (optOutMemoryCache.has(v)) {
      return {
        blocked: true,
        reason: `Contato em lista Opt-Out / PARAR (${rawPhone}).`
      };
    }
  }

  return { blocked: false };
}

export async function recordOptOutPhone(params: {
  phone: string | null | undefined;
  orgNome?: string | null;
  reason?: string | null;
}): Promise<{ ok: boolean; recordedToSheets: boolean; error?: string }> {
  const norm = normalizeDigits(params.phone);
  if (!norm) {
    return { ok: false, recordedToSheets: false, error: 'Telefone inválido para opt-out.' };
  }

  for (const v of getPhoneVariants(norm)) {
    optOutMemoryCache.add(v);
  }

  try {
    const auth = getGoogleSheetsAuth();
    if (!auth) {
      return { ok: true, recordedToSheets: false, error: 'GCP_DRIVE_CREDENTIALS não configurada.' };
    }

    const spreadsheetId =
      (env.WHATSAPP_MONITOR_SHEET_ID || process.env.WHATSAPP_MONITOR_SHEET_ID || '').trim() ||
      DEFAULT_MONITOR_SHEET_ID;

    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Opt_Out!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [
          [
            getBrasiliaTimestamp(),
            norm,
            params.orgNome || 'OSC',
            (params.reason || 'PARAR').slice(0, 300),
            'SIM'
          ]
        ]
      }
    });

    lastSheetSyncAt = Date.now();
    return { ok: true, recordedToSheets: true };
  } catch (err: any) {
    console.warn('[whatsapp-optout] Falha ao gravar Opt_Out no Sheets:', err?.message || err);
    return {
      ok: true,
      recordedToSheets: false,
      error: err?.message || 'Erro ao gravar na aba Opt_Out'
    };
  }
}
