import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface QueueItem {
  order: number;
  org: string;
  phone: string;
  message: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUEUE_PATH = path.resolve(__dirname, '../src/data/monday_followup_queue.json');
const DEFAULT_API_BASE = 'https://triade-matchmaker-ui.vercel.app';
const DEFAULT_PAUSE_FILE = '/tmp/monday_batch.pause';
const DEFAULT_STATE_FILE = '/tmp/monday_batch_state.json';

const HARD_BLOCKED_CESAR = new Set(['558134196700', '8134196700']);

function normalizeDigits(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits}`;
}

function isBlockedCesar(phone: string): boolean {
  const norm = normalizeDigits(phone);
  return HARD_BLOCKED_CESAR.has(norm) || HARD_BLOCKED_CESAR.has(norm.slice(-10));
}

function parseArgs(argv: string[]) {
  const args: {
    mode: 'list' | 'test' | 'live';
    testPhone?: string;
    apiBase: string;
    pauseFile: string;
    stateFile: string;
    startFrom: number;
    prefixTestHeader: boolean;
  } = {
    mode: 'list',
    apiBase: DEFAULT_API_BASE,
    pauseFile: DEFAULT_PAUSE_FILE,
    stateFile: DEFAULT_STATE_FILE,
    startFrom: 1,
    prefixTestHeader: false
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.mode = 'live';
    else if (a === '--list') args.mode = 'list';
    else if (a === '--test-phone' && argv[i + 1]) {
      args.mode = 'test';
      args.testPhone = argv[++i];
    } else if (a === '--api-base' && argv[i + 1]) {
      args.apiBase = argv[++i].replace(/\/+$/, '');
    } else if (a === '--pause-file' && argv[i + 1]) {
      args.pauseFile = argv[++i];
    } else if (a === '--state-file' && argv[i + 1]) {
      args.stateFile = argv[++i];
    } else if (a === '--start-from' && argv[i + 1]) {
      args.startFrom = Number(argv[++i]) || 1;
    } else if (a === '--prefix-test-header') {
      args.prefixTestHeader = true;
    }
  }
  return args;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepCheckingPause(ms: number, pauseFile: string): Promise<boolean> {
  const step = 1000;
  let elapsed = 0;
  while (elapsed < ms) {
    if (fs.existsSync(pauseFile)) return false;
    const wait = Math.min(step, ms - elapsed);
    await sleep(wait);
    elapsed += wait;
  }
  return !fs.existsSync(pauseFile);
}

async function sendViaApi(
  apiBase: string,
  phone: string,
  message: string,
  forceSendOutsideHours: boolean
): Promise<{ ok: boolean; error?: string; messageId?: string; blockedByOptOut?: boolean }> {
  try {
    const res = await fetch(`${apiBase}/api/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        message,
        enforceBusinessHours: !forceSendOutsideHours,
        forceSendOutsideHours
      })
    });
    const data = (await res.json()) as any;
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        blockedByOptOut: !!data?.blockedByOptOut,
        error: data?.error || `HTTP ${res.status}`
      };
    }
    return { ok: true, messageId: data.messageId };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw: QueueItem[] = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));

  const cesarFound = raw.find((item) => isBlockedCesar(item.phone));
  if (cesarFound) {
    console.error(`FATAL: CESAR (+55 81 3419-6700) encontrado na fila (${cesarFound.org}). Abortando.`);
    process.exit(1);
  }

  const queue = raw
    .filter((item) => !isBlockedCesar(item.phone))
    .sort((a, b) => a.order - b.order);

  if (args.mode === 'list') {
    console.log(`Fila definitiva (${queue.length} contatos) | CESAR +55 81 3419-6700 EXCLUÍDO:`);
    for (const item of queue) {
      console.log(`  #${String(item.order).padStart(2, '0')} | ${item.phone.padEnd(17)} | ${item.org}`);
    }
    return;
  }

  if (fs.existsSync(args.pauseFile)) {
    console.error(`Arquivo de pausa ativo (${args.pauseFile}). Remova-o para executar.`);
    process.exit(2);
  }

  if (args.mode === 'test') {
    const testPhone = normalizeDigits(args.testPhone || '');
    if (!testPhone || testPhone.length < 12 || isBlockedCesar(testPhone)) {
      console.error('Número de teste inválido ou bloqueado.');
      process.exit(1);
    }

    console.log(`🧪 Modo TESTE PRÉ-09H: enviando ${queue.length} mensagens para +${testPhone} via ${args.apiBase}...`);
    const opener = await sendViaApi(
      args.apiBase,
      testPhone,
      `🧪 TESTE PRÉ-09H (Segunda 16/11): A seguir vão as ${queue.length} mensagens exatas na ordem #1 a #17 para conferência da Maria Angela. (CESAR +55 81 3419-6700 excluído.)`,
      true
    );
    if (!opener.ok) {
      console.error(`❌ Falha na abertura do teste: ${opener.error}`);
      process.exit(1);
    }

    for (let i = 0; i < queue.length; i++) {
      if (fs.existsSync(args.pauseFile)) {
        console.warn(`⏸️ Pausado via ${args.pauseFile} antes da #${queue[i].order}.`);
        process.exit(0);
      }

      await sleep(1500);
      const item = queue[i];
      if (item.order < args.startFrom) continue;

      const text = args.prefixTestHeader
        ? `[TESTE #${item.order}/17 | ${item.org} | ${item.phone}]\n\n${item.message}`
        : item.message;

      const res = await sendViaApi(args.apiBase, testPhone, text, true);
      if (!res.ok) {
        console.error(`❌ Erro no teste #${item.order} (${item.org}): ${res.error}`);
        if (i < 3) {
          console.error('🛑 PARADA AUTOMÁTICA: erro nas 3 primeiras mensagens.');
          process.exit(1);
        }
      } else {
        console.log(`  ✅ Teste #${item.order}/17 enviado (${item.org} — ${item.phone})`);
      }
    }
    console.log('🏁 Teste concluído.');
    return;
  }

  // Modo LIVE (Segunda 09h+)
  let sentOrders = new Set<number>();
  if (fs.existsSync(args.stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(args.stateFile, 'utf8'));
      if (Array.isArray(saved.sentOrders)) {
        sentOrders = new Set<number>(saved.sentOrders);
      }
    } catch {
      // ignore corrupted state
    }
  }

  const saveState = () => {
    fs.writeFileSync(
      args.stateFile,
      JSON.stringify({ updatedAt: new Date().toISOString(), sentOrders: Array.from(sentOrders) }, null, 2)
    );
  };

  console.log(`🚀 Modo LIVE Segunda-feira (1 a ${queue.length}) | API: ${args.apiBase}`);
  console.log(`   Para pausar a qualquer momento: touch ${args.pauseFile}`);

  let consecutiveErrors = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (item.order < args.startFrom || sentOrders.has(item.order)) {
      continue;
    }

    if (fs.existsSync(args.pauseFile)) {
      console.warn(`⏸️ Pausa detectada (${args.pauseFile}) antes de #${item.order}. Encerrando com segurança.`);
      process.exit(0);
    }

    if (isBlockedCesar(item.phone)) {
      console.warn(`🚫 Ignorado por bloqueio CESAR: ${item.phone}`);
      continue;
    }

    const res = await sendViaApi(args.apiBase, item.phone, item.message, false);
    if (!res.ok) {
      consecutiveErrors += 1;
      console.error(`❌ Falha em #${item.order} (${item.org} — ${item.phone}): ${res.error}`);

      if (i < 3) {
        console.error('🛑 PARADA AUTOMÁTICA DE SEGURANÇA: erro/bloqueio nas 3 primeiras mensagens. Abortando!');
        process.exit(1);
      }
      if (consecutiveErrors >= 2) {
        console.error('🛑 PARADA AUTOMÁTICA DE SEGURANÇA: 2 erros consecutivos. Abortando!');
        process.exit(1);
      }
    } else {
      consecutiveErrors = 0;
      sentOrders.add(item.order);
      saveState();
      console.log(`  ✅ #${item.order}/17 enviado para ${item.phone} (${item.org}) | id=${res.messageId || 'ok'}`);
    }

    const remaining = queue.slice(i + 1).some((q) => !sentOrders.has(q.order));
    if (remaining) {
      const delayMs = 60_000 + Math.floor(Math.random() * 120_000); // 1 a 3 min
      console.log(`   ⏳ Aguardando ${Math.round(delayMs / 1000)}s (touch ${args.pauseFile} para pausar)...`);
      const ok = await sleepCheckingPause(delayMs, args.pauseFile);
      if (!ok) {
        console.warn(`⏸️ Pausa detectada durante intervalo (${args.pauseFile}). Encerrando.`);
        process.exit(0);
      }
    }
  }

  console.log('🏁 Disparo Segunda-feira (1 a 17) concluído com sucesso!');
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
