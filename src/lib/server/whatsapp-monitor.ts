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

export async function upsertFavorableContactToSheet(input: FavorableContactInput): Promise<boolean> {
  if (input.isSimulator) {
    return false;
  }

  try {
    const auth = getGoogleAuth();
    if (!auth) return false;

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
    const targetTail = normalizePhoneTail(input.phone);
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
    console.warn('[whatsapp-monitor] Falha ao gravar em Contatos_Favoraveis:', err?.message || err);
    return false;
  }
}
