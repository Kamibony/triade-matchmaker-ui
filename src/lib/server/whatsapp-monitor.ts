import { env } from '$env/dynamic/private';
import { google } from 'googleapis';

const DEFAULT_MONITOR_SHEET_ID = '1okK96biPmEpSwxFYFakvjfdfaFJ6tM5DKE9A_64DMAU';

export interface WhatsAppMonitorEvent {
  eventType: 'ignored' | 'analyzed_only' | 'auto_replied' | 'opt_out' | 'error';
  isSimulator?: boolean;
  phone?: string | null;
  orgNome?: string | null;
  editalId?: string | number | null;
  intent?: string | null;
  crmStatus?: string | null;
  incomingText?: string | null;
  replyMessage?: string | null;
  detail?: string | null;
}

function formatBrasiliaTimestamp(now = new Date()): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);
}

function getGoogleAuth() {
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

export async function logWhatsAppWebhookEvent(event: WhatsAppMonitorEvent): Promise<{
  loggedToVercel: boolean;
  loggedToSheets: boolean;
  sheetsError?: string;
}> {
  const timestampBrt = formatBrasiliaTimestamp();

  // 1. Always emit structured JSON log for Vercel Runtime Logs
  console.log(
    JSON.stringify({
      source: 'whatsapp-webhook',
      timestampBrt,
      eventType: event.eventType,
      isSimulator: !!event.isSimulator,
      phone: event.phone || null,
      orgNome: event.orgNome || null,
      editalId: event.editalId ?? null,
      intent: event.intent || null,
      crmStatus: event.crmStatus || null,
      incomingPreview: event.incomingText ? event.incomingText.slice(0, 120) : null,
      replyPreview: event.replyMessage ? event.replyMessage.slice(0, 120) : null,
      detail: event.detail || null
    })
  );

  // Skip writing simulator tests to the live monitoring spreadsheet
  if (event.isSimulator) {
    return { loggedToVercel: true, loggedToSheets: false };
  }

  // 2. Append row to Google Sheets (non-blocking / fault-tolerant)
  try {
    const auth = getGoogleAuth();
    if (!auth) {
      return {
        loggedToVercel: true,
        loggedToSheets: false,
        sheetsError: 'GCP_DRIVE_CREDENTIALS não configurada.'
      };
    }

    const spreadsheetId =
      (env.WHATSAPP_MONITOR_SHEET_ID || process.env.WHATSAPP_MONITOR_SHEET_ID || '').trim() ||
      DEFAULT_MONITOR_SHEET_ID;

    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'WhatsApp_Log!A:J',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [
          [
            timestampBrt,
            event.eventType,
            event.phone || '',
            event.orgNome || '',
            event.editalId ? String(event.editalId) : '',
            event.intent || '',
            event.crmStatus || '',
            (event.incomingText || '').slice(0, 500),
            (event.replyMessage || '').slice(0, 500),
            event.detail || ''
          ]
        ]
      }
    });

    return { loggedToVercel: true, loggedToSheets: true };
  } catch (err: any) {
    console.warn('[whatsapp-monitor] Falha ao gravar no Google Sheets:', err?.message || err);
    return {
      loggedToVercel: true,
      loggedToSheets: false,
      sheetsError: err?.message || 'Erro desconhecido no Google Sheets'
    };
  }
}

export interface FavorableContactInput {
  isSimulator?: boolean;
  contactName: string;
  orgNome: string;
  phone: string;
  editalLabel?: string | null;
  statusNote: string;
  observation?: string | null;
}

function normalizePhoneTail(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.slice(-8);
}

function formatPhoneDisplay(raw: string): string {
  const trimmed = String(raw || '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return trimmed;
  if (digits.startsWith('55') && digits.length === 12) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  if (digits.startsWith('55') && digits.length === 13) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}

const RECENT_SYNC_LOCK_MS = 30_000;
const recentFavorableSyncTails = new Map<string, number>();

export async function upsertFavorableContactToSheet(input: FavorableContactInput): Promise<boolean> {
  if (input.isSimulator) {
    return false;
  }

  const targetTail = normalizePhoneTail(input.phone);
  const now = Date.now();
  if (targetTail) {
    const lastSync = recentFavorableSyncTails.get(targetTail);
    if (lastSync && now - lastSync < RECENT_SYNC_LOCK_MS) {
      return false;
    }
    recentFavorableSyncTails.set(targetTail, now);
  }

  try {
    const auth = getGoogleAuth();
    if (!auth) {
      if (targetTail) recentFavorableSyncTails.delete(targetTail);
      return false;
    }

    const spreadsheetId =
      (env.WHATSAPP_MONITOR_SHEET_ID || process.env.WHATSAPP_MONITOR_SHEET_ID || '').trim() ||
      DEFAULT_MONITOR_SHEET_ID;

    const sheets = google.sheets({ version: 'v4', auth });
    const existingRes = await sheets.spreadsheets.values
      .get({
        spreadsheetId,
        range: 'Contatos_Favoraveis!A:G'
      })
      .catch(() => null);

    const rows = existingRes?.data?.values || [];
    const alreadyExists = targetTail
      ? rows.slice(1).some((r) => normalizePhoneTail(String(r?.[2] || '')) === targetTail)
      : false;

    if (alreadyExists) {
      return false;
    }

    const formattedPhone = formatPhoneDisplay(input.phone);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Contatos_Favoraveis!A:G',
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          [
            input.contactName || 'Contato principal',
            input.orgNome || 'Organização',
            formattedPhone,
            input.editalLabel || '',
            input.statusNote,
            input.observation || '',
            formatBrasiliaTimestamp()
          ]
        ]
      }
    });

    return true;
  } catch (err: any) {
    if (targetTail) recentFavorableSyncTails.delete(targetTail);
    console.warn('[whatsapp-monitor] Falha ao gravar em Contatos_Favoraveis:', err?.message || err);
    return false;
  }
}

export interface FavorableContactRow {
  contactName: string;
  orgNome: string;
  phone: string;
  editalLabel: string;
  statusNote: string;
  observation: string;
  updatedAt: string;
}

export async function getFavorableContactsFromSheet(): Promise<FavorableContactRow[]> {
  const auth = getGoogleAuth();
  if (!auth) {
    throw new Error('GCP_DRIVE_CREDENTIALS não configurada.');
  }

  const spreadsheetId =
    (env.WHATSAPP_MONITOR_SHEET_ID || process.env.WHATSAPP_MONITOR_SHEET_ID || '').trim() ||
    DEFAULT_MONITOR_SHEET_ID;

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Contatos_Favoraveis!A:G'
  });

  const rows = res.data.values || [];
  const seenTails = new Set<string>();
  const contacts: FavorableContactRow[] = [];

  for (const r of rows.slice(1)) {
    const contactName = String(r?.[0] || '').trim();
    const orgNome = String(r?.[1] || '').trim();
    const phone = String(r?.[2] || '').trim();
    if (!phone && !contactName && !orgNome) continue;

    const tail = normalizePhoneTail(phone);
    if (tail && seenTails.has(tail)) continue;
    if (tail) seenTails.add(tail);

    contacts.push({
      contactName: contactName || 'Contato principal',
      orgNome: orgNome || 'Organização',
      phone,
      editalLabel: String(r?.[3] || '').trim(),
      statusNote: String(r?.[4] || '').trim(),
      observation: String(r?.[5] || '').trim(),
      updatedAt: String(r?.[6] || '').trim()
    });
  }

  return contacts;
}

function escapeVCardValue(val: string): string {
  return String(val || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function toE164Digits(rawPhone: string): string {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 11) return `+55${digits}`;
  return `+${digits}`;
}

export function buildFavorableContactsVcf(contacts: FavorableContactRow[]): string {
  const cards: string[] = [];

  for (const c of contacts) {
    const tel = toE164Digits(c.phone);
    if (!tel) continue;

    // Strip redundant parenthetical location only from FN if needed, keeping clean "Nome — OSC"
    const cleanOrgShort = c.orgNome.replace(/\s*\([^)]+\)\s*$/, '').trim() || c.orgNome;
    const displayName =
      c.contactName && !c.contactName.toLowerCase().startsWith('contato principal')
        ? `${c.contactName} — ${cleanOrgShort}`
        : cleanOrgShort;

    const noteParts = [
      c.editalLabel ? `Edital: ${c.editalLabel}` : '',
      c.statusNote ? `Status: ${c.statusNote}` : '',
      c.observation ? `Obs: ${c.observation}` : '',
      c.updatedAt ? `Atualizado (BRT): ${c.updatedAt}` : ''
    ].filter(Boolean);

    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${escapeVCardValue(displayName)}`,
      `N:;${escapeVCardValue(displayName)};;;`,
      `ORG:${escapeVCardValue(c.orgNome)}`,
      `TEL;TYPE=CELL,VOICE:${tel}`,
      'CATEGORIES:Triade ACR',
      noteParts.length ? `NOTE:${escapeVCardValue(noteParts.join(' | '))}` : '',
      'END:VCARD'
    ].filter(Boolean);

    cards.push(lines.join('\r\n'));
  }

  return cards.join('\r\n') + (cards.length ? '\r\n' : '');
}
