<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import rawQueue from '../../data/monday_followup_queue.json';

  export let overrideConfig: any = undefined;

  interface FollowupItem {
    order: number;
    org: string;
    phone: string;
    message: string;
  }

  type ItemStatus = 'pending' | 'sending' | 'sent' | 'error';

  interface ItemRuntimeState {
    status: ItemStatus;
    sentAt?: string;
    error?: string;
    messageId?: string;
  }

  const CESAR_BLOCKED_DIGITS = ['558134196700', '8134196700'];
  const STORAGE_KEY = 'triade_monday_16_11_followup_v1';

  function normalizeDigits(phone: string): string {
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits}`;
  }

  function isBlockedCesar(phone: string): boolean {
    const norm = normalizeDigits(phone);
    return CESAR_BLOCKED_DIGITS.some((b) => norm === b || norm.endsWith(b));
  }

  const queue: FollowupItem[] = (rawQueue as FollowupItem[])
    .filter((item) => !isBlockedCesar(item.phone))
    .sort((a, b) => a.order - b.order);

  let stateByOrder: Record<number, ItemRuntimeState> = {};
  let expandedOrder: number | null = null;

  // Controls
  let runningMode: 'idle' | 'live' | 'test' = 'idle';
  let paused = false;
  let safetyStopReason = '';
  let statusBanner = '';
  let countdownSeconds = 0;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let liveConfirmed = false;

  // Pre-09h Test controls (Angela's phone)
  let angelaTestPhone = '';
  let testPrefixHeader = false;
  let testProgressCount = 0;
  let testLastError = '';

  onMount(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        stateByOrder = JSON.parse(saved);
      }
      const savedPhone = localStorage.getItem('triade_angela_test_phone');
      if (savedPhone) angelaTestPhone = savedPhone;
    } catch {
      stateByOrder = {};
    }
  });

  onDestroy(() => {
    clearCountdown();
  });

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateByOrder));
    } catch {
      // ignore storage quota errors
    }
  }

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    countdownSeconds = 0;
  }

  function pauseDispatch() {
    paused = true;
    runningMode = 'idle';
    clearCountdown();
    statusBanner = '⏸️ Disparo pausado manualmente pelo operador. Nenhuma nova mensagem será enviada até você retomar.';
  }

  function resetLiveState() {
    if (runningMode !== 'idle') return;
    stateByOrder = {};
    safetyStopReason = '';
    statusBanner = '';
    saveState();
  }

  function sleepWithCountdown(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      clearCountdown();
      countdownSeconds = Math.ceil(ms / 1000);
      countdownTimer = setInterval(() => {
        if (paused || runningMode === 'idle') {
          clearCountdown();
          resolve(false);
          return;
        }
        countdownSeconds -= 1;
        if (countdownSeconds <= 0) {
          clearCountdown();
          resolve(true);
        }
      }, 1000);
    });
  }

  async function sendOne(params: {
    phone: string;
    message: string;
    forceSendOutsideHours: boolean;
  }): Promise<{ ok: boolean; error?: string; messageId?: string; blockedByOptOut?: boolean }> {
    try {
      const payload: Record<string, any> = {
        phone: params.phone,
        message: params.message,
        enforceBusinessHours: !params.forceSendOutsideHours,
        forceSendOutsideHours: params.forceSendOutsideHours
      };
      if (overrideConfig?.apiToken) {
        payload.overrideConfig = overrideConfig;
      }

      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        return {
          ok: false,
          blockedByOptOut: !!data.blockedByOptOut,
          error: data.error || `HTTP ${res.status}`
        };
      }
      return { ok: true, messageId: data.messageId };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Erro de rede ao enviar' };
    }
  }

  async function startLiveMondayDispatch() {
    if (runningMode !== 'idle' || !liveConfirmed) return;

    paused = false;
    safetyStopReason = '';
    statusBanner = '🚀 Disparo Segunda-feira (1 a 17) iniciado com intervalo aleatório de 1 a 3 minutos...';
    runningMode = 'live';

    let consecutiveErrors = 0;

    for (let i = 0; i < queue.length; i++) {
      if (paused || runningMode !== 'live') break;

      const item = queue[i];
      if (isBlockedCesar(item.phone)) continue;

      const currentState = stateByOrder[item.order];
      if (currentState?.status === 'sent') continue;

      stateByOrder = {
        ...stateByOrder,
        [item.order]: { status: 'sending' }
      };
      saveState();

      const result = await sendOne({
        phone: item.phone,
        message: item.message,
        forceSendOutsideHours: false // Sempre respeita janela comercial Seg-Sex 09:00-17:30 BRT
      });

      if (result.ok) {
        consecutiveErrors = 0;
        stateByOrder = {
          ...stateByOrder,
          [item.order]: {
            status: 'sent',
            sentAt: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
            messageId: result.messageId
          }
        };
        saveState();
      } else {
        consecutiveErrors += 1;
        stateByOrder = {
          ...stateByOrder,
          [item.order]: {
            status: 'error',
            error: result.error
          }
        };
        saveState();

        // Condição 3 da Angela: se aparecer erro ou bloqueio nas 3 primeiras, parar sozinho!
        if (i < 3) {
          paused = true;
          runningMode = 'idle';
          clearCountdown();
          safetyStopReason = `🛑 PARADA AUTOMÁTICA DE SEGURANÇA (Primeiras 3 mensagens): Erro no envio #${item.order} (${item.org} — ${item.phone}): ${result.error}. O disparo foi interrompido imediatamente.`;
          statusBanner = '';
          return;
        }

        // Proteção extra: 2 erros seguidos em qualquer ponto também pausa
        if (consecutiveErrors >= 2) {
          paused = true;
          runningMode = 'idle';
          clearCountdown();
          safetyStopReason = `🛑 PARADA AUTOMÁTICA (2 erros seguidos): Último erro em #${item.order} (${item.phone}): ${result.error}. Verifique o Whapi antes de continuar.`;
          statusBanner = '';
          return;
        }
      }

      // Verifica se ainda há próximo item pendente para aguardar de 1 a 3 minutos
      const hasRemaining = queue.slice(i + 1).some((nextItem) => stateByOrder[nextItem.order]?.status !== 'sent');
      if (hasRemaining && !paused && runningMode === 'live') {
        const delayMs = 60_000 + Math.floor(Math.random() * 120_000); // 1 a 3 min
        statusBanner = `⏳ #${item.order} enviado (${item.phone}). Aguardando ${Math.round(delayMs / 1000)}s antes do próximo contato...`;
        const okToContinue = await sleepWithCountdown(delayMs);
        if (!okToContinue) break;
      }
    }

    if (runningMode === 'live' && !paused) {
      runningMode = 'idle';
      statusBanner = '✅ Lote de 17 mensagens concluído!';
    }
  }

  async function startPreNineTest() {
    const cleanTarget = normalizeDigits(angelaTestPhone);
    if (!cleanTarget || cleanTarget.length < 12) {
      testLastError = 'Informe um número de WhatsApp válido com DDD (ex: 83 9 9999-9999).';
      return;
    }
    if (isBlockedCesar(cleanTarget)) {
      testLastError = 'Número bloqueado permanentemente.';
      return;
    }

    try {
      localStorage.setItem('triade_angela_test_phone', angelaTestPhone);
    } catch {
      // ignore
    }

    paused = false;
    safetyStopReason = '';
    testLastError = '';
    testProgressCount = 0;
    runningMode = 'test';
    statusBanner = `🧪 Enviando teste das ${queue.length} mensagens para o WhatsApp da Angela (${angelaTestPhone})...`;

    // Mensagem introdutória do teste
    const introRes = await sendOne({
      phone: cleanTarget,
      message: `🧪 TESTE PRÉ-09H (Segunda 16/11): A seguir vão as ${queue.length} mensagens exatas na ordem #1 a #17 para conferência da Maria Angela. (CESAR +55 81 3419-6700 está excluído.)`,
      forceSendOutsideHours: true
    });

    if (!introRes.ok) {
      runningMode = 'idle';
      paused = true;
      testLastError = `Falha ao enviar abertura do teste: ${introRes.error}`;
      statusBanner = '';
      return;
    }

    for (let i = 0; i < queue.length; i++) {
      if (paused || runningMode !== 'test') break;
      const item = queue[i];

      const waitOk = await sleepWithCountdown(1500);
      if (!waitOk) break;

      const textToSend = testPrefixHeader
        ? `[TESTE #${item.order}/17 | ${item.org} | ${item.phone}]\n\n${item.message}`
        : item.message;

      const res = await sendOne({
        phone: cleanTarget,
        message: textToSend,
        forceSendOutsideHours: true
      });

      if (!res.ok) {
        testLastError = `Erro no teste #${item.order} (${item.org}): ${res.error}`;
        if (i < 3) {
          paused = true;
          runningMode = 'idle';
          safetyStopReason = `🛑 Teste interrompido automaticamente nas 3 primeiras mensagens (#${item.order}): ${res.error}`;
          statusBanner = '';
          return;
        }
      } else {
        testProgressCount = i + 1;
      }
    }

    if (runningMode === 'test' && !paused) {
      runningMode = 'idle';
      statusBanner = `✅ Teste concluído: ${testProgressCount}/17 mensagens enviadas para ${angelaTestPhone}.`;
    }
  }

  $: sentCount = queue.filter((q) => stateByOrder[q.order]?.status === 'sent').length;
  $: errorCount = queue.filter((q) => stateByOrder[q.order]?.status === 'error').length;
</script>

<div class="bg-white rounded-xl shadow-sm border-2 border-emerald-300 overflow-hidden">
  <!-- Header -->
  <div class="p-4 bg-gradient-to-r from-emerald-50 via-teal-50 to-white border-b border-emerald-200 flex flex-wrap items-center justify-between gap-3">
    <div>
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-base font-extrabold text-emerald-950">
          📋 Lote Aprovado — Retorno Segunda-feira (16/11, 09h BRT) • 17 Contatos
        </h3>
        <span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-300">
          🚫 EXCLUÍDO PERMANENTEMENTE: CESAR (+55 81 3419-6700)
        </span>
      </div>
      <p class="text-xs text-gray-700 mt-1">
        Ordem definitiva (#1 Esperança → #17 P.A.R.E.), textos exatos de <code>mensagens-finais-segunda-16-11-2026.md</code>, intervalo de 1–3 min, botão de pausa e trava automática se houver erro nas 3 primeiras.
      </p>
    </div>

    <div class="flex items-center gap-2">
      {#if runningMode !== 'idle'}
        <button
          type="button"
          onclick={pauseDispatch}
          class="px-4 py-2 rounded-lg text-xs font-extrabold bg-red-600 text-white hover:bg-red-700 shadow-sm animate-pulse"
        >
          ⏸️ PAUSAR DISPARO AGORA
        </button>
      {/if}
      <button
        type="button"
        disabled={runningMode !== 'idle'}
        onclick={resetLiveState}
        class="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
      >
        🔄 Resetar Estado
      </button>
    </div>
  </div>

  <!-- Alerts -->
  {#if safetyStopReason}
    <div class="mx-4 mt-4 p-3 rounded-lg bg-red-50 border-2 border-red-400 text-xs text-red-900 font-semibold">
      {safetyStopReason}
    </div>
  {/if}

  {#if statusBanner}
    <div class="mx-4 mt-4 p-3 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-950 font-medium flex flex-wrap items-center justify-between gap-2">
      <span>{statusBanner}</span>
      {#if countdownSeconds > 0}
        <span class="px-2 py-0.5 rounded bg-amber-200 text-amber-950 font-bold">
          ⏱️ {countdownSeconds}s
        </span>
      {/if}
    </div>
  {/if}

  <!-- Pre-09h Test Box & Live Controls -->
  <div class="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4 border-b border-gray-100 bg-gray-50/70">
    <!-- Condição 2: Teste no número da Angela antes das 9h -->
    <div class="p-3.5 rounded-lg bg-white border border-indigo-200 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-xs font-bold text-indigo-950">
          🧪 1. Teste Pré-09h no WhatsApp da Angela (17 mensagens)
        </h4>
        {#if testProgressCount > 0}
          <span class="text-[11px] font-bold text-indigo-700">{testProgressCount}/17 enviadas</span>
        {/if}
      </div>
      <p class="text-[11px] text-gray-600">
        Envia as 17 mensagens exatas exclusivamente para o número da Angela para leitura antes do disparo oficial das 9h.
      </p>
      <div class="flex flex-wrap gap-2">
        <input
          type="text"
          bind:value={angelaTestPhone}
          placeholder="WhatsApp da Angela (ex: +55 83 9XXXX-XXXX)"
          class="flex-1 min-w-[200px] px-3 py-1.5 text-xs border border-gray-300 rounded-md"
        />
        <button
          type="button"
          disabled={runningMode !== 'idle' || !angelaTestPhone.trim()}
          onclick={startPreNineTest}
          class="px-3 py-1.5 rounded-md text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300"
        >
          Enviar Teste (17 msgs)
        </button>
      </div>
      <label class="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer">
        <input type="checkbox" bind:checked={testPrefixHeader} />
        Incluir etiqueta <code>[TESTE #N/17 | Org | Tel]</code> no topo de cada mensagem
      </label>
      {#if testLastError}
        <p class="text-[11px] text-red-700 font-semibold">{testLastError}</p>
      {/if}
    </div>

    <!-- Condição 3 e 5: Disparo Oficial Segunda 09h -->
    <div class="p-3.5 rounded-lg bg-white border border-emerald-200 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-xs font-bold text-emerald-950">
          🚀 2. Disparo Oficial Segunda-feira 16/11 (09:00 BRT)
        </h4>
        <span class="text-[11px] font-bold text-emerald-800">
          {sentCount}/17 enviadas {errorCount > 0 ? `• ${errorCount} erro(s)` : ''}
        </span>
      </div>
      <p class="text-[11px] text-gray-600">
        Respeita horário comercial (09:00–17:30 BRT), intervalo de 1–3 min entre contatos e para sozinho em qualquer erro nas 3 primeiras.
      </p>
      <label class="flex items-start gap-2 text-[11px] text-gray-700 cursor-pointer">
        <input type="checkbox" bind:checked={liveConfirmed} class="mt-0.5" />
        <span>
          Confirmo que o teste da Angela foi aprovado, estamos na janela da segunda 16/11 (≥ 09h BRT) e o CESAR (+55 81 3419-6700) está excluído.
        </span>
      </label>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={runningMode !== 'idle' || !liveConfirmed || sentCount === queue.length}
          onclick={startLiveMondayDispatch}
          class="px-4 py-1.5 rounded-md text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300"
        >
          {sentCount > 0 && sentCount < queue.length ? '▶️ Retomar Disparo (Pendentes)' : '▶️ Iniciar Disparo (1 a 17)'}
        </button>
        {#if runningMode !== 'idle'}
          <button
            type="button"
            onclick={pauseDispatch}
            class="px-4 py-1.5 rounded-md text-xs font-bold bg-red-600 text-white hover:bg-red-700"
          >
            ⏸️ Pausar
          </button>
        {/if}
      </div>
    </div>
  </div>

  <!-- Lista por Telefone (1 a 17) -->
  <div class="divide-y divide-gray-100 max-h-[460px] overflow-y-auto">
    {#each queue as item}
      {@const st = stateByOrder[item.order]}
      <div class="p-3 hover:bg-gray-50 transition-colors">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="px-2 py-0.5 rounded bg-gray-900 text-white font-bold">#{item.order}</span>
            <span class="font-mono font-bold text-emerald-900">{item.phone}</span>
            <span class="font-semibold text-gray-800">{item.org}</span>
            {#if item.order <= 3}
              <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">
                Sentinela erro (Top 3)
              </span>
            {/if}
            {#if item.order === 17}
              <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-800">
                Último da fila (P.A.R.E.)
              </span>
            {/if}
          </div>

          <div class="flex items-center gap-2">
            {#if st?.status === 'sent'}
              <span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800">
                ✅ Enviado ({st.sentAt})
              </span>
            {:else if st?.status === 'sending'}
              <span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-100 text-blue-800 animate-pulse">
                ⏳ Enviando...
              </span>
            {:else if st?.status === 'error'}
              <span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800" title={st.error}>
                ❌ Erro: {st.error}
              </span>
            {:else}
              <span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-600">
                ⏸️ Pendente
              </span>
            {/if}

            <button
              type="button"
              onclick={() => { expandedOrder = expandedOrder === item.order ? null : item.order; }}
              class="px-2 py-1 rounded text-[11px] font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-100"
            >
              {expandedOrder === item.order ? 'Ocultar texto' : 'Ver texto exato'}
            </button>
          </div>
        </div>

        {#if expandedOrder === item.order}
          <div class="mt-2 p-3 rounded-lg bg-emerald-50/50 border border-emerald-200 text-xs text-gray-800 whitespace-pre-line font-sans">
            {item.message}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>
