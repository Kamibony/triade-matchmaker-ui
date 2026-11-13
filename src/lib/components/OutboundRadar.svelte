<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';

  export let leads: any[] = [];
  export let bancoEditais: any[] = [];

  const BRAZIL_UFS = [
    'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
    'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN',
    'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
  ];

  // CRM State in localStorage: key = `${edital_id}_${cnpj}` -> { status: 'contacted' | 'negotiating' | 'archived', updatedAt: string }
  let crmState: Record<string, { status: string; updatedAt: string }> = {};
  let hideContactedOrArchived = false;
  let onlyStarred = false;
  let onlyWhatsApp = false;
  let minDaysFilter = 15;

  // WhatsApp Launch Mode:
  // 'api' = Direct background API send (0 browser tabs, 0 reload!)
  // 'app' = Native whatsapp:// protocol (WhatsApp Desktop app from Microsoft Store)
  // 'web' = Browser web.whatsapp.com
  let whatsappMode: 'api' | 'app' | 'web' = 'web';
  let copiedFeedbackKey: string | null = null;
  let directSendFeedbackKey: string | null = null;

  // Message Template Mode per card: 'opener' | 'initial' | 'followup' | 'audio'
  let messageModeByCard: Record<string, 'opener' | 'initial' | 'followup' | 'audio'> = {};

  // --- In-Browser Gateway Configuration (for instant 7-day experiment setup) ---
  let customGatewayConfig = {
    provider: 'whapi' as 'whapi' | 'zapi' | 'greenapi' | 'evolution',
    apiUrl: 'https://gate.whapi.cloud',
    apiToken: '',
    instanceId: 'triade'
  };
  let gatewayConfigSavedMsg = '';

  // --- Business-Hours Automation Queue & 7-Day Experiment Analytics ---
  interface QueuedLeadItem {
    key: string;
    lead: any;
    phone: string;
    phoneType: 'mobile' | 'landline';
    message: string;
    useTwoStepOpener: boolean;
    status: 'waiting_hours' | 'queued' | 'sending' | 'sent' | 'error';
    queuedAt: string;
    sentAt?: string;
    error?: string;
    replyIntent?: string;
    replyText?: string;
  }

  let autoQueue: QueuedLeadItem[] = [];
  let queueRunning = false;
  let useTwoStepAntiBan = true;
  let forceSendOutsideBusinessHours = false;
  let brtClockText = '';
  let isCurrentlyBusinessHours = false;
  let gatewayStatus: { provider: string; configured: boolean } = { provider: 'simulation', configured: false };
  let queueTimer: any = null;
  let clockTimer: any = null;

  // AI SDR Simulator / Live Tester State
  let sdrSelectedLeadKey = '';
  let sdrIncomingInput = 'Olá! Pode mandar o resumo sim! Qual é o nome desse edital e como funciona a consultoria de vocês?';
  let sdrLoading = false;
  let sdrConversation: Array<{
    role: 'ong' | 'ai';
    text: string;
    meta?: any;
    timestamp: string;
  }> = [];

  function updateBrasiliaClock() {
    try {
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
      const wk = (map.weekday || '').toLowerCase();
      const isWeekend = wk.includes('sáb') || wk.includes('sab') || wk.includes('dom');
      const dec = hour + minute / 60;
      isCurrentlyBusinessHours = !isWeekend && dec >= 9.0 && dec <= 17.5;
      brtClockText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} BRT (${map.weekday})`;
    } catch {
      brtClockText = 'Horário de Brasília';
    }
  }

  onMount(async () => {
    updateBrasiliaClock();
    clockTimer = setInterval(updateBrasiliaClock, 20000);

    try {
      const saved = localStorage.getItem('triade_outbound_crm_v1');
      if (saved) crmState = JSON.parse(saved);

      const savedWaMode = localStorage.getItem('triade_whatsapp_mode');
      if (savedWaMode === 'api' || savedWaMode === 'app' || savedWaMode === 'web') {
        whatsappMode = savedWaMode;
      }

      const savedQueue = localStorage.getItem('triade_whatsapp_queue_v1');
      if (savedQueue) autoQueue = JSON.parse(savedQueue);

      const savedGw = localStorage.getItem('triade_whatsapp_gateway_v1');
      if (savedGw) {
        customGatewayConfig = { ...customGatewayConfig, ...JSON.parse(savedGw) };
      }
    } catch {
      crmState = {};
    }

    try {
      const res = await fetch('/api/whatsapp/send');
      if (res.ok) {
        const data = await res.json();
        gatewayStatus = {
          provider: customGatewayConfig.apiToken ? customGatewayConfig.provider : data.provider,
          configured: !!customGatewayConfig.apiToken || data.configured
        };
      }
    } catch {}
  });

  onDestroy(() => {
    if (queueTimer) clearTimeout(queueTimer);
    if (clockTimer) clearInterval(clockTimer);
  });

  function saveGatewayConfig() {
    try {
      localStorage.setItem('triade_whatsapp_gateway_v1', JSON.stringify(customGatewayConfig));
      gatewayStatus = {
        provider: customGatewayConfig.apiToken ? customGatewayConfig.provider : 'simulation',
        configured: !!customGatewayConfig.apiToken
      };
      if (customGatewayConfig.apiToken) {
        whatsappMode = 'api';
        localStorage.setItem('triade_whatsapp_mode', 'api');
      }
      gatewayConfigSavedMsg = '✓ Configuração salva! Disparo sem abrir abas ativado.';
      setTimeout(() => { gatewayConfigSavedMsg = ''; }, 4000);
    } catch {}
  }

  function saveQueue() {
    try {
      localStorage.setItem('triade_whatsapp_queue_v1', JSON.stringify(autoQueue));
    } catch {}
  }

  function setWhatsAppMode(mode: 'api' | 'app' | 'web') {
    whatsappMode = mode;
    try {
      localStorage.setItem('triade_whatsapp_mode', mode);
    } catch {}
  }

  function getLeadKey(editalId: string, cnpj: string): string {
    return `${editalId}_${cnpj}`;
  }

  function setLeadStatus(editalId: string, cnpj: string, status: 'pending' | 'contacted' | 'negotiating' | 'archived') {
    const key = getLeadKey(editalId, cnpj);
    if (status === 'pending') {
      delete crmState[key];
      crmState = { ...crmState };
    } else {
      crmState = {
        ...crmState,
        [key]: {
          status,
          updatedAt: new Date().toLocaleDateString('pt-BR')
        }
      };
    }
    try {
      localStorage.setItem('triade_outbound_crm_v1', JSON.stringify(crmState));
    } catch {}
  }

  function formatCurrency(val: number | null | undefined): string {
    if (!val) return 'Valor não inf.';
    if (val >= 1000000) {
      return `R$ ${(val / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
    }
    if (val >= 1000) {
      return `R$ ${(val / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
    }
    return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function formatPrazoBadge(prazo: string | null | undefined, diasRestantes: number | null | undefined) {
    if (!prazo || prazo === 'Não informado') {
      return { label: 'Fluxo Contínuo', color: 'bg-blue-50 text-blue-700 border-blue-200' };
    }
    const dateFormatted = prazo.split('-').reverse().join('/');
    if (diasRestantes !== null && diasRestantes !== undefined) {
      if (diasRestantes < 0) {
        return { label: `Encerrado (${dateFormatted})`, color: 'bg-red-100 text-red-800 border-red-200' };
      }
      if (diasRestantes <= 15) {
        return { label: `⚠️ ${dateFormatted} (${diasRestantes}d)`, color: 'bg-amber-100 text-amber-800 border-amber-300' };
      }
      return { label: `⏳ ${dateFormatted} (${diasRestantes}d)`, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    }
    return { label: `⏳ ${dateFormatted}`, color: 'bg-gray-100 text-gray-700 border-gray-200' };
  }

  // Group leads by Edital and apply minDaysFilter
  let groupedLeads: Record<string, any> = {};
  $: {
    groupedLeads = leads.reduce((acc, lead) => {
      const dias = lead.dias_restantes;
      if (minDaysFilter > 0 && dias !== null && dias !== undefined && dias < minDaysFilter) {
        return acc;
      }
      if (!acc[lead.edital_id]) {
        acc[lead.edital_id] = {
          titulo: lead.edital_titulo,
          valor: lead.edital_valor,
          prazo: lead.edital_prazo,
          dias_restantes: lead.dias_restantes,
          ufs: lead.edital_ufs || [],
          leads: []
        };
      }
      acc[lead.edital_id].leads.push(lead);
      return acc;
    }, {});
  }

  let selectedEditalId: string | null = null;
  $: if ((!selectedEditalId || !groupedLeads[selectedEditalId]) && Object.keys(groupedLeads).length > 0) {
    selectedEditalId = Object.keys(groupedLeads)[0];
  }

  $: if (!sdrSelectedLeadKey && leads.length > 0) {
    const firstLead = leads[0];
    sdrSelectedLeadKey = getLeadKey(firstLead.edital_id, firstLead.osc?.cnpj);
  }

  // --- 7-Day Experiment Analytics Computed Metrics ---
  $: totalLeadsWithPhone = leads.filter(l => hasAnyPhone(l)).length;
  $: totalMobileLeads = leads.filter(l => getPhoneType(l) === 'mobile').length;
  $: totalLandlineLeads = leads.filter(l => getPhoneType(l) === 'landline').length;
  $: sentQueueItems = autoQueue.filter(i => i.status === 'sent');
  $: repliedQueueItems = autoQueue.filter(i => !!i.replyIntent);

  let openDossierIndex: number | null = null;

  // Navigation Tabs: 'daily' | 'manual' | 'automation'
  let activeTab: 'daily' | 'manual' | 'automation' = 'daily';
  let editalSource: 'banco' | 'link' = 'banco';
  let bancoSearchFilter = '';
  let bancoMinDays = 20;
  let manualSearchPdfUrl = '';
  let manualSearchKeywords = '';
  let manualSearchEditalId = '';
  let manualTargetUf = '';
  let manualTargetMunicipio = '';
  let manualSearchLoading = false;
  let manualSearchResults: any[] = [];
  let manualEvaluationProgress = '';

  $: filteredBancoEditais = bancoEditais.filter(e => {
    if (bancoMinDays > 0 && e.dias_restantes !== null && e.dias_restantes !== undefined && e.dias_restantes < bancoMinDays) {
      return false;
    }
    if (!bancoSearchFilter.trim()) return true;
    const q = bancoSearchFilter.toLowerCase();
    const matchTitle = (e.titulo || '').toLowerCase().includes(q);
    const matchTheme = (e.temas_principais || []).some((t: string) => t.toLowerCase().includes(q));
    const matchUf = (e.estados_permitidos || []).some((u: string) => u.toLowerCase().includes(q));
    return matchTitle || matchTheme || matchUf;
  });

  $: selectedBancoEditalObj = bancoEditais.find(e => String(e.id) === String(manualSearchEditalId)) || null;

  function getScoreColor(score: number) {
    if (score >= 85) return 'text-green-700 bg-green-100 border border-green-200';
    if (score >= 70) return 'text-yellow-700 bg-yellow-100 border border-yellow-200';
    return 'text-orange-700 bg-orange-100 border border-orange-200';
  }

  function toggleDossier(index: number) {
    openDossierIndex = openDossierIndex === index ? null : index;
  }

  function getCleanPhoneNumber(lead: any): string | null {
    const raw = lead.contatos_encontrados?.whatsapp || lead.osc?.official_contacts?.ddd_telefone_1 || lead.osc?.official_contacts?.ddd_telefone_2;
    if (!raw) return null;
    const digits = raw.toString().replace(/\D/g, '');
    if (digits.length < 10) return null;
    return digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
  }

  function getPhoneType(lead: any): 'mobile' | 'landline' | null {
    const clean = getCleanPhoneNumber(lead);
    if (!clean || clean.length < 10) return null;
    const local = clean.slice(2); // after 2-digit DDD
    if (local.length === 9 && local.startsWith('9')) return 'mobile';
    if (local.length === 8 && (local.startsWith('8') || local.startsWith('9') || local.startsWith('7'))) return 'mobile';
    return 'landline';
  }

  function hasDirectWhatsApp(lead: any): boolean {
    return !!lead.contatos_encontrados?.whatsapp;
  }

  function hasAnyPhone(lead: any): boolean {
    return !!getCleanPhoneNumber(lead);
  }

  function buildAntiBanOpener(lead: any): string {
    const valorStr = lead.edital_valor ? formatCurrency(lead.edital_valor) : 'valor expressivo';
    return `Olá, pessoal da ${lead.osc?.nome}, tudo bem? Aqui é da equipe da Maria Angela, da Triade Captação de Recursos. Vimos a atuação de vocês em ${lead.osc?.municipio} e mapeamos um edital aberto de até ${valorStr} muito alinhado ao perfil da instituição. Posso enviar um resumo rápido por aqui?`;
  }

  function getActiveMessage(lead: any): string {
    const key = getLeadKey(lead.edital_id, lead.osc?.cnpj);
    const mode = messageModeByCard[key] || 'initial';
    const valorStr = lead.edital_valor ? formatCurrency(lead.edital_valor) : 'valor expressivo';
    const prazoStr = lead.dias_restantes ? `faltam apenas ${lead.dias_restantes} dias para o encerramento` : 'as inscrições estão abertas';

    if (mode === 'opener') {
      return buildAntiBanOpener(lead);
    }
    if (mode === 'followup') {
      return `Olá, equipe da ${lead.osc?.nome}! Tudo bem? Aqui é a Maria Angela Bonifacio, da Triade ACR. Enviei uma mensagem recentemente sobre uma oportunidade de edital de até ${valorStr} muito alinhada à atuação de vocês em ${lead.osc?.municipio}. Como ${prazoStr}, queria saber se vocês têm 5 minutinhos hoje ou amanhã para eu explicar como podemos estruturar esse projeto juntos?`;
    }
    if (mode === 'audio') {
      return `🎙️ [ROTEIRO PARA GRAVAR ÁUDIO DE 25s NO WHATSAPP]:\n\n1. "Olá, pessoal da ${lead.osc?.nome}, tudo bem? Aqui quem fala é a Maria Angela, consultora de captação da Triade."\n2. "Estou entrando em contato porque mapeamos um edital aberto de até ${valorStr} que encaixa perfeitamente com o trabalho de vocês em ${lead.osc?.municipio}."\n3. "Como ${prazoStr}, me manda um 'oi' aqui se vocês tiverem interesse que eu explico rapidinho os detalhes sem compromisso. Um abraço!"`;
    }
    return lead.whatsapp_message || '';
  }

  function getWhatsAppLink(lead: any, message: string): string | null {
    const cleanPhone = getCleanPhoneNumber(lead);
    if (!cleanPhone) return null;
    const encoded = encodeURIComponent(message || '');
    if (whatsappMode === 'app') {
      return `whatsapp://send?phone=55${cleanPhone}&text=${encoded}`;
    }
    return `https://web.whatsapp.com/send?phone=55${cleanPhone}&text=${encoded}`;
  }

  function copyMessageOnly(lead: any, message: string) {
    const key = getLeadKey(lead.edital_id || 'manual', lead.osc?.cnpj || '');
    try {
      navigator.clipboard?.writeText(message || '');
      copiedFeedbackKey = key;
      setTimeout(() => {
        if (copiedFeedbackKey === key) copiedFeedbackKey = null;
      }, 2000);
    } catch {}
  }

  async function openWhatsAppSmart(event: MouseEvent, lead: any, message: string, markContacted = true) {
    event.preventDefault();
    const cleanPhone = getCleanPhoneNumber(lead);
    if (!cleanPhone) return;
    const key = getLeadKey(lead.edital_id || 'manual', lead.osc?.cnpj || '');

    try {
      navigator.clipboard?.writeText(message || '');
    } catch {}

    if (markContacted && lead.edital_id && lead.osc?.cnpj) {
      setLeadStatus(lead.edital_id, lead.osc.cnpj, 'contacted');
    }

    // Mode 1: Direct Background API Send (0 tabs opened, 0 reload!)
    if (whatsappMode === 'api') {
      directSendFeedbackKey = key;
      try {
        await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: `55${cleanPhone}`,
            message,
            lead,
            useTwoStepOpener: false,
            enforceBusinessHours: false,
            forceSendOutsideHours: true,
            overrideConfig: customGatewayConfig.apiToken ? customGatewayConfig : undefined
          })
        });
      } catch {}
      setTimeout(() => {
        if (directSendFeedbackKey === key) directSendFeedbackKey = null;
      }, 3000);
      return;
    }

    const encoded = encodeURIComponent(message || '');
    if (whatsappMode === 'app') {
      window.location.href = `whatsapp://send?phone=55${cleanPhone}&text=${encoded}`;
    } else {
      const url = `https://web.whatsapp.com/send?phone=55${cleanPhone}&text=${encoded}`;
      const win = window.open(url, 'whatsapp_triade');
      if (win) {
        win.focus();
      }
    }
  }

  // --- Business-Hours Queue Functions ---
  function addLeadToAutoQueue(lead: any, customMsg?: string) {
    const cleanPhone = getCleanPhoneNumber(lead);
    if (!cleanPhone) return;
    const key = getLeadKey(lead.edital_id, lead.osc?.cnpj);
    if (autoQueue.some(item => item.key === key)) return;

    const msg = useTwoStepAntiBan ? buildAntiBanOpener(lead) : customMsg || getActiveMessage(lead);
    const pType = getPhoneType(lead) || 'landline';
    autoQueue = [
      ...autoQueue,
      {
        key,
        lead,
        phone: `55${cleanPhone}`,
        phoneType: pType,
        message: msg,
        useTwoStepOpener: useTwoStepAntiBan,
        status: isCurrentlyBusinessHours || forceSendOutsideBusinessHours ? 'queued' : 'waiting_hours',
        queuedAt: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      }
    ];
    saveQueue();
  }

  function enqueueAllLeadsForExperiment(minScore = 0, onlyMobile = false) {
    // Sort so mobile phones and higher scores go first
    const sorted = [...leads].sort((a, b) => {
      const mA = getPhoneType(a) === 'mobile' ? 1 : 0;
      const mB = getPhoneType(b) === 'mobile' ? 1 : 0;
      if (mA !== mB) return mB - mA;
      return (b.score || 0) - (a.score || 0);
    });

    for (const lead of sorted) {
      if ((lead.score || 0) < minScore) continue;
      const key = getLeadKey(lead.edital_id, lead.osc?.cnpj);
      if (crmState[key]?.status === 'archived') continue;
      if (!hasAnyPhone(lead)) continue;
      if (onlyMobile && getPhoneType(lead) !== 'mobile') continue;
      if (autoQueue.some(item => item.key === key)) continue;
      addLeadToAutoQueue(lead);
    }
    activeTab = 'automation';
  }

  function removeQueueItem(key: string) {
    autoQueue = autoQueue.filter(i => i.key !== key);
    saveQueue();
  }

  function clearSentFromQueue() {
    autoQueue = autoQueue.filter(i => i.status !== 'sent');
    saveQueue();
  }

  function exportExperimentCsv() {
    const headers = [
      'CNPJ',
      'ONG',
      'UF',
      'Municipio',
      'Edital_ID',
      'Score',
      'Telefone',
      'Tipo_Telefone',
      'Modo_Mensagem',
      'Status_Envio',
      'Horario_Envio',
      'Status_CRM',
      'Intencao_Resposta_IA'
    ];
    const rows = autoQueue.map(item => {
      const crmSt = crmState[item.key]?.status || 'pending';
      return [
        item.lead?.osc?.cnpj || '',
        `"${(item.lead?.osc?.nome || '').replace(/"/g, '""')}"`,
        item.lead?.osc?.uf || '',
        `"${(item.lead?.osc?.municipio || '').replace(/"/g, '""')}"`,
        item.lead?.edital_id || '',
        item.lead?.score || 0,
        item.phone,
        item.phoneType,
        item.useTwoStepOpener ? 'Anti-Ban 2 Linhas' : 'Pitch Completo',
        item.status,
        item.sentAt || '',
        crmSt,
        `"${(item.replyIntent || '').replace(/"/g, '""')}"`
      ].join(',');
    });
    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `experimento_whatsapp_triade_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function processNextInQueue() {
    if (!queueRunning) return;
    updateBrasiliaClock();

    if (!isCurrentlyBusinessHours && !forceSendOutsideBusinessHours) {
      autoQueue = autoQueue.map(i => (i.status === 'queued' ? { ...i, status: 'waiting_hours' } : i));
      saveQueue();
      queueTimer = setTimeout(processNextInQueue, 60000);
      return;
    }

    const nextIdx = autoQueue.findIndex(i => i.status === 'queued' || i.status === 'waiting_hours');
    if (nextIdx === -1) {
      queueRunning = false;
      return;
    }

    autoQueue[nextIdx].status = 'sending';
    autoQueue = [...autoQueue];

    const item = autoQueue[nextIdx];
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: item.phone,
          message: item.message,
          lead: item.lead,
          useTwoStepOpener: item.useTwoStepOpener,
          enforceBusinessHours: !forceSendOutsideBusinessHours,
          forceSendOutsideHours: forceSendOutsideBusinessHours,
          overrideConfig: customGatewayConfig.apiToken ? customGatewayConfig : undefined
        })
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        autoQueue[nextIdx].status = 'sent';
        autoQueue[nextIdx].sentAt = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        setLeadStatus(item.lead.edital_id, item.lead.osc.cnpj, 'contacted');
      } else {
        autoQueue[nextIdx].status = data.queuedForBusinessHours ? 'waiting_hours' : 'error';
        autoQueue[nextIdx].error = data.error || 'Falha no envio';
      }
    } catch (e: any) {
      autoQueue[nextIdx].status = 'error';
      autoQueue[nextIdx].error = e.message || 'Erro de rede';
    }

    autoQueue = [...autoQueue];
    saveQueue();

    if (queueRunning) {
      // If real WhatsApp API connected, wait humanized 180s–300s (3 to 5 min); in simulation, 1.5s
      const delayMs = gatewayStatus.configured ? 180000 + Math.floor(Math.random() * 120000) : 1500;
      queueTimer = setTimeout(processNextInQueue, delayMs);
    }
  }

  function toggleQueueRunner() {
    queueRunning = !queueRunning;
    if (queueRunning) {
      processNextInQueue();
    } else if (queueTimer) {
      clearTimeout(queueTimer);
    }
  }

  // --- AI SDR Simulator / Webhook Tester ---
  async function simulateIncomingOngReply(presetText?: string) {
    const textToSend = (presetText ?? sdrIncomingInput).trim();
    if (!textToSend) return;

    const selectedLead =
      leads.find(l => getLeadKey(l.edital_id, l.osc?.cnpj) === sdrSelectedLeadKey) || leads[0] || null;

    const nowStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    sdrConversation = [
      ...sdrConversation,
      { role: 'ong', text: textToSend, timestamp: nowStr }
    ];
    sdrIncomingInput = '';
    sdrLoading = true;

    try {
      const res = await fetch('/api/whatsapp/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          simulator: true,
          incomingText: textToSend,
          lead: selectedLead,
          history: sdrConversation.map(m => ({ role: m.role, text: m.text })),
          overrideConfig: customGatewayConfig.apiToken ? customGatewayConfig : undefined
        })
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Falha ao analisar resposta com IA SDR.');
      }

      const sdr = data.sdrResult;
      if (selectedLead && sdr.crm_status) {
        setLeadStatus(selectedLead.edital_id, selectedLead.osc.cnpj, sdr.crm_status);
        const qIdx = autoQueue.findIndex(q => q.key === getLeadKey(selectedLead.edital_id, selectedLead.osc.cnpj));
        if (qIdx !== -1) {
          autoQueue[qIdx].replyIntent = sdr.intent_label || sdr.intent;
          autoQueue[qIdx].replyText = textToSend;
          autoQueue = [...autoQueue];
          saveQueue();
        }
      }

      sdrConversation = [
        ...sdrConversation,
        {
          role: 'ai',
          text: sdr.reply_message,
          meta: sdr,
          timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        }
      ];
    } catch (e: any) {
      sdrConversation = [
        ...sdrConversation,
        {
          role: 'ai',
          text: `⚠️ Erro na análise: ${e.message}`,
          timestamp: nowStr
        }
      ];
    } finally {
      sdrLoading = false;
    }
  }

  function sortAndFilterLeads(leadList: any[]): any[] {
    let list = [...leadList];
    if (onlyWhatsApp) {
      list = list.filter(lead => hasAnyPhone(lead));
    }
    if (onlyStarred) {
      list = list.filter(lead => crmState[getLeadKey(lead.edital_id, lead.osc?.cnpj)]?.status === 'negotiating');
    }
    if (hideContactedOrArchived) {
      list = list.filter(lead => {
        const st = crmState[getLeadKey(lead.edital_id, lead.osc?.cnpj)]?.status;
        return st !== 'contacted' && st !== 'archived';
      });
    } else {
      list = list.filter(lead => crmState[getLeadKey(lead.edital_id, lead.osc?.cnpj)]?.status !== 'archived');
    }

    return list.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  async function performManualSearch() {
    if ((editalSource === 'banco' && !manualSearchEditalId) || (editalSource === 'link' && !manualSearchPdfUrl)) return;

    manualSearchLoading = true;
    manualSearchResults = [];
    manualEvaluationProgress = 'Iniciando busca inteligente de OSCs...';

    try {
      let parsedEdital = null;

      if (editalSource === 'link') {
        manualEvaluationProgress = 'Baixando e analisando PDF do Edital...';
        const parseRes = await fetch('/api/outbound/parse-edital', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdfUrl: manualSearchPdfUrl })
        });

        const parseData = await parseRes.json().catch(() => ({}));
        if (!parseRes.ok) {
          throw new Error(parseData.error || 'Erro ao analisar o PDF do Edital. Verifique o link e tente novamente.');
        }
        parsedEdital = parseData;
        manualEvaluationProgress = `Edital extraído: "${parsedEdital.titulo}". Buscando OSCs compatíveis...`;
      } else {
        manualEvaluationProgress = 'Buscando OSCs compatíveis no banco de dados e IPEA...';
      }

      const discoverRes = await fetch('/api/outbound/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editalId: editalSource === 'banco' ? manualSearchEditalId : undefined,
          edital: parsedEdital,
          customKeywords: manualSearchKeywords.trim() || undefined,
          targetUf: manualTargetUf || undefined,
          targetMunicipio: manualTargetMunicipio.trim() || undefined
        })
      });

      const discoverData = await discoverRes.json().catch(() => ({}));
      if (!discoverRes.ok) {
        throw new Error(discoverData.error || 'Erro na fase de descoberta de OSCs.');
      }

      const { topOscs, edital } = discoverData;

      if (!topOscs || topOscs.length === 0) {
        manualEvaluationProgress = 'Nenhuma OSC compatível encontrada para os critérios informados.';
        manualSearchResults = [];
        return;
      }

      manualSearchResults = topOscs.map((osc: any) => ({
        osc,
        loading: true,
        evaluated: false
      }));

      for (let i = 0; i < topOscs.length; i++) {
        manualEvaluationProgress = `Avaliando OSC ${i + 1} de ${topOscs.length}: ${topOscs[i].nome}...`;

        try {
          const evalRes = await fetch('/api/outbound/evaluate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ edital, osc: topOscs[i] })
          });

          if (evalRes.ok) {
            const matchResult = await evalRes.json();
            manualSearchResults[i] = {
              ...matchResult,
              edital_valor: edital.valor_maximo_ou_global_reais,
              edital_prazo: edital.prazo_de_inscricao,
              loading: false,
              evaluated: true
            };
          } else {
            manualSearchResults[i].loading = false;
            manualSearchResults[i].error = 'Erro na avaliação da OSC';
          }
        } catch (e: any) {
          manualSearchResults[i].loading = false;
          manualSearchResults[i].error = e.message || 'Erro na requisição de avaliação';
        }

        manualSearchResults = [...manualSearchResults];
      }

      manualEvaluationProgress = `Busca concluída! ${manualSearchResults.filter(r => r.evaluated).length} OSCs avaliadas.`;
    } catch (e: any) {
      alert(e.message || 'Ocorreu um erro durante a busca manual.');
      manualEvaluationProgress = `Erro na busca: ${e.message}`;
    } finally {
      manualSearchLoading = false;
    }
  }
</script>

<div class="flex h-full font-sans overflow-hidden">
  <!-- Left Pane: Editais List / Manual Search Form / Automation Summary -->
  <div class="w-1/3 bg-white border-r border-gray-200 flex flex-col h-full">
    <div class="p-5 border-b border-gray-200">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-gray-900">Radar de Prospecção</h1>
        <span class="text-xs font-medium px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700">
          {bancoEditais.length} editais ativos
        </span>
      </div>

      <!-- Tabs -->
      <div class="flex space-x-3 mt-4 border-b border-gray-200 text-xs sm:text-sm">
        <button
          class="pb-2 font-medium {activeTab === 'daily' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500 hover:text-gray-700'}"
          onclick={() => { activeTab = 'daily'; }}
        >
          Pipeline Diário
        </button>
        <button
          class="pb-2 font-medium {activeTab === 'manual' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500 hover:text-gray-700'}"
          onclick={() => { activeTab = 'manual'; }}
        >
          Busca Manual ({bancoEditais.length})
        </button>
        <button
          class="pb-2 font-semibold flex items-center gap-1 {activeTab === 'automation' ? 'text-green-700 border-b-2 border-green-600' : 'text-gray-500 hover:text-gray-700'}"
          onclick={() => { activeTab = 'automation'; }}
        >
          🤖 Automação WA
          {#if autoQueue.filter(i => i.status !== 'sent').length > 0}
            <span class="px-1.5 py-0.5 text-[10px] rounded-full bg-green-100 text-green-800 font-bold">
              {autoQueue.filter(i => i.status !== 'sent').length}
            </span>
          {/if}
        </button>
      </div>

      {#if activeTab === 'daily'}
        <!-- Prazo Minimum Filter Bar -->
        <div class="mt-3 flex items-center justify-between bg-gray-50 px-3 py-2 rounded-lg border border-gray-200 text-xs">
          <span class="font-medium text-gray-600">Prazo mínimo p/ captar:</span>
          <div class="flex space-x-1">
            {#each [{ label: 'Todos', val: 0 }, { label: '≥ 15 dias', val: 15 }, { label: '≥ 30 dias', val: 30 }] as opt}
              <button
                class="px-2 py-1 rounded font-medium transition-colors {minDaysFilter === opt.val ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-100'}"
                onclick={() => { minDaysFilter = opt.val; }}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if activeTab === 'daily'}
        {#each Object.entries(groupedLeads) as [id, data]}
          {@const badge = formatPrazoBadge(data.prazo, data.dias_restantes)}
          <button
            class="w-full text-left p-4 border-b border-gray-100 hover:bg-indigo-50 transition-colors {selectedEditalId === id ? 'bg-indigo-50 border-l-4 border-indigo-600' : 'border-l-4 border-transparent'}"
            onclick={() => { selectedEditalId = id; openDossierIndex = null; }}
          >
            <div class="flex justify-between items-start gap-2">
              <h3 class="font-semibold text-sm text-gray-900 line-clamp-2">{data.titulo}</h3>
              <span class="shrink-0 inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                {data.leads.length} leads
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-2 mt-2">
              <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-green-50 text-green-700 border border-green-200">
                💰 {formatCurrency(data.valor)}
              </span>
              <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border {badge.color}">
                {badge.label}
              </span>
              {#if data.ufs?.length > 0}
                <span class="text-xs text-gray-500 font-medium">📍 {data.ufs.join(', ')}</span>
              {/if}
            </div>
          </button>
        {/each}
      {:else if activeTab === 'manual'}
        <!-- Manual Search Form -->
        <div class="p-5 space-y-4">
          <div class="flex space-x-4 mb-2">
            <label class="inline-flex items-center cursor-pointer">
              <input type="radio" bind:group={editalSource} value="banco" class="form-radio text-indigo-600 h-4 w-4" />
              <span class="ml-2 text-sm font-medium text-gray-700">Banco Prosas ({filteredBancoEditais.length})</span>
            </label>
            <label class="inline-flex items-center cursor-pointer">
              <input type="radio" bind:group={editalSource} value="link" class="form-radio text-indigo-600 h-4 w-4" />
              <span class="ml-2 text-sm font-medium text-gray-700">Link de PDF Externo</span>
            </label>
          </div>

          {#if editalSource === 'banco'}
            <div class="space-y-3 bg-gray-50 p-3 rounded-lg border border-gray-200">
              <div class="flex items-center justify-between text-xs">
                <span class="font-semibold text-gray-700">Filtrar Editais do Banco:</span>
                <select bind:value={bancoMinDays} class="border border-gray-300 rounded px-2 py-1 text-xs bg-white">
                  <option value={0}>Qualquer prazo aberto</option>
                  <option value={15}>Mínimo 15 dias restantes</option>
                  <option value={20}>Mínimo 20 dias restantes</option>
                  <option value={30}>Mínimo 30 dias restantes</option>
                  <option value={45}>Mínimo 45 dias restantes</option>
                </select>
              </div>

              <input
                type="text"
                bind:value={bancoSearchFilter}
                placeholder="🔍 Buscar edital por tema, nome ou UF (ex: cultura, RS, criança)..."
                class="block w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />

              <div>
                <label class="block text-xs font-semibold text-gray-700 mb-1">
                  Selecione o Edital ({filteredBancoEditais.length} disponíveis):
                </label>
                <select
                  bind:value={manualSearchEditalId}
                  class="block w-full pl-2 pr-8 py-2 text-sm border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 rounded-md border bg-white"
                >
                  <option value="" disabled>Escolha um edital aberto...</option>
                  {#each filteredBancoEditais as item}
                    <option value={item.id}>
                      [{formatCurrency(item.valor)} | {item.dias_restantes !== null ? `Faltam ${item.dias_restantes}d` : 'Contínuo'}{item.estados_permitidos?.length ? ` | ${item.estados_permitidos.join(',')}` : ' | BR'}] {item.titulo}
                    </option>
                  {/each}
                </select>
              </div>

              {#if selectedBancoEditalObj}
                {@const selBadge = formatPrazoBadge(selectedBancoEditalObj.prazo, selectedBancoEditalObj.dias_restantes)}
                <div class="p-2.5 bg-white rounded border border-indigo-100 text-xs space-y-1.5">
                  <div class="flex flex-wrap gap-1.5">
                    <span class="px-2 py-0.5 rounded font-bold bg-green-50 text-green-700 border border-green-200">
                      💰 {formatCurrency(selectedBancoEditalObj.valor)}
                    </span>
                    <span class="px-2 py-0.5 rounded font-medium border {selBadge.color}">
                      {selBadge.label}
                    </span>
                    {#if selectedBancoEditalObj.url}
                      <a href={selectedBancoEditalObj.url} target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-medium ml-auto">
                        📄 Abrir Edital ↗
                      </a>
                    {/if}
                  </div>
                  <p class="text-gray-600 line-clamp-3">{selectedBancoEditalObj.resumo_objetivo}</p>
                </div>
              {/if}
            </div>
          {:else}
            <div>
              <label class="block text-sm font-medium text-gray-700">Link do PDF do Edital (ou Google Drive)</label>
              <input
                type="url"
                bind:value={manualSearchPdfUrl}
                placeholder="https://exemplo.com/edital.pdf"
                class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              />
            </div>
          {/if}

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-gray-700">Estado Alvo (UF)</label>
              <select
                bind:value={manualTargetUf}
                class="mt-1 block w-full px-2 py-2 text-sm border border-gray-300 rounded-md bg-white"
              >
                <option value="">Automático (Do Edital)</option>
                {#each BRAZIL_UFS as uf}
                  <option value={uf}>{uf}</option>
                {/each}
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700">Município (Opcional)</label>
              <input
                type="text"
                bind:value={manualTargetMunicipio}
                placeholder="Ex: Recife, Joinville..."
                class="mt-1 block w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
              />
            </div>
          </div>

          <div>
            <label class="block text-xs font-semibold text-gray-700">Palavras-chave Extras (Opcional)</label>
            <input
              type="text"
              bind:value={manualSearchKeywords}
              placeholder="Ex: mulheres, reciclagem, idosos, musical..."
              class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
            />
          </div>

          <button
            onclick={performManualSearch}
            disabled={manualSearchLoading || (editalSource === 'banco' ? !manualSearchEditalId : !manualSearchPdfUrl)}
            class="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-indigo-300"
          >
            {manualSearchLoading ? 'Buscando e Avaliando OSCs...' : '🚀 Prospectar OSCs para este Edital'}
          </button>

          {#if manualSearchLoading || manualEvaluationProgress}
            <div class="mt-3 p-3 bg-blue-50 text-blue-800 text-xs rounded-md border border-blue-200 font-medium">
              {manualEvaluationProgress}
            </div>
          {/if}
        </div>
      {:else}
        <!-- Left Pane for Automation Tab: Controls, Gateway Setup & 7-Day Experiment Buttons -->
        <div class="p-4 space-y-4">
          <div class="p-3.5 rounded-xl border {isCurrentlyBusinessHours ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'} space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold uppercase tracking-wider {isCurrentlyBusinessHours ? 'text-green-800' : 'text-amber-800'}">
                {isCurrentlyBusinessHours ? '🟢 Horário Comercial Ativo' : '🌙 Aguardando 09h00 BRT'}
              </span>
              <span class="text-xs font-semibold text-gray-700">{brtClockText}</span>
            </div>
            <p class="text-[11px] text-gray-600">
              Disparo cadenciado: <strong>Seg–Sex, 09:00 às 17:30 BRT</strong> com intervalo humano (3–5 min) e efeito <em>"digitando..."</em>.
            </p>
          </div>

          <!-- Instant Gateway Configurator (Connect Angela's WhatsApp via QR Code API) -->
          <div class="p-3.5 rounded-xl bg-gray-50 border border-gray-200 space-y-2.5 text-xs">
            <div class="flex items-center justify-between">
              <span class="font-bold text-gray-800">🔌 Conectar Número da Angela (0 Abas):</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold {gatewayStatus.configured ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}">
                {gatewayStatus.configured ? `Ativo (${gatewayStatus.provider})` : 'Modo Simulação'}
              </span>
            </div>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-[11px] font-medium text-gray-600">Provedor API (QR Code):</label>
                <select bind:value={customGatewayConfig.provider} class="mt-0.5 w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                  <option value="whapi">Whapi.cloud (5 dias Grátis)</option>
                  <option value="zapi">Z-API (Teste Grátis BR)</option>
                  <option value="greenapi">Green-API (Grátis)</option>
                  <option value="evolution">Evolution API</option>
                </select>
              </div>
              <div>
                <label class="block text-[11px] font-medium text-gray-600">API URL:</label>
                <input
                  type="text"
                  bind:value={customGatewayConfig.apiUrl}
                  placeholder="https://gate.whapi.cloud"
                  class="mt-0.5 w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white"
                />
              </div>
            </div>

            <div>
              <label class="block text-[11px] font-medium text-gray-600">API Token (cole aqui após ler o QR Code):</label>
              <div class="flex gap-1.5 mt-0.5">
                <input
                  type="password"
                  bind:value={customGatewayConfig.apiToken}
                  placeholder="Cole o Token da sua instância..."
                  class="flex-1 px-2 py-1 text-xs border border-gray-300 rounded bg-white"
                />
                <button
                  type="button"
                  onclick={saveGatewayConfig}
                  class="px-2.5 py-1 rounded text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  Salvar
                </button>
              </div>
              {#if gatewayConfigSavedMsg}
                <p class="text-[11px] text-emerald-700 font-semibold mt-1">{gatewayConfigSavedMsg}</p>
              {/if}
            </div>
          </div>

          <div class="space-y-2">
            <label class="flex items-start gap-2 p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 cursor-pointer text-xs">
              <input type="checkbox" bind:checked={useTwoStepAntiBan} class="mt-0.5 rounded border-indigo-300 text-indigo-600" />
              <div>
                <span class="font-bold text-indigo-900">🛡️ Abertura Anti-Ban (2 linhas s/ link)</span>
                <p class="text-[11px] text-indigo-700">
                  Pergunta primeiro se pode enviar o resumo. Protege o número da Angela e triplica a taxa de resposta!
                </p>
              </div>
            </label>

            <label class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 cursor-pointer text-xs">
              <input type="checkbox" bind:checked={forceSendOutsideBusinessHours} class="rounded border-gray-300 text-indigo-600" />
              <span class="font-medium text-gray-700">Permitir disparo fora das 09h–17h30 (Teste)</span>
            </label>
          </div>

          <!-- 7-Day Experiment Enqueue Buttons -->
          <div class="space-y-2 pt-1 border-t border-gray-200">
            <span class="block text-[11px] font-bold uppercase text-gray-500">🧪 Experimento de 7 Dias (Coleta de Dados):</span>
            <button
              type="button"
              onclick={() => enqueueAllLeadsForExperiment(0, false)}
              class="w-full py-2 px-3 rounded-lg shadow-sm text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 transition-colors"
            >
              🧪 Enfileirar TODOS os Leads ({totalLeadsWithPhone} ONGs)
            </button>

            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                onclick={() => enqueueAllLeadsForExperiment(0, true)}
                class="py-1.5 px-2 rounded-lg text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200"
              >
                📱 Só Celulares ({totalMobileLeads})
              </button>
              <button
                type="button"
                onclick={() => enqueueAllLeadsForExperiment(80, false)}
                class="py-1.5 px-2 rounded-lg text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200"
              >
                ⭐ Só Score ≥ 80%
              </button>
            </div>
          </div>

          <button
            type="button"
            onclick={toggleQueueRunner}
            disabled={autoQueue.filter(i => i.status !== 'sent').length === 0}
            class="w-full py-2.5 px-4 rounded-lg shadow-sm text-xs font-bold text-white transition-colors {queueRunning ? 'bg-amber-600 hover:bg-amber-700' : 'bg-green-600 hover:bg-green-700 disabled:bg-gray-300'}"
          >
            {queueRunning ? '⏸️ Pausar Disparo Automático' : '▶️ Iniciar Disparo Automático'}
          </button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Right Pane: Leads Feed / Manual Results / Automation & AI SDR Console -->
  <div class="w-2/3 flex flex-col h-full bg-gray-100">
    {#if activeTab === 'daily'}
      {#if selectedEditalId && groupedLeads[selectedEditalId]}
        {@const currentGroup = groupedLeads[selectedEditalId]}
        {@const headerBadge = formatPrazoBadge(currentGroup.prazo, currentGroup.dias_restantes)}
        <div class="p-5 bg-white border-b border-gray-200 shadow-sm z-10 shrink-0 space-y-3">
          <div class="flex justify-between items-start gap-4">
            <div>
              <h2 class="text-lg font-bold text-gray-900">
                <span class="text-indigo-600">{currentGroup.titulo}</span>
              </h2>
              <div class="flex flex-wrap items-center gap-2 mt-1.5">
                <span class="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-bold bg-green-50 text-green-700 border border-green-200">
                  💰 Valor: {formatCurrency(currentGroup.valor)}
                </span>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold border {headerBadge.color}">
                  {headerBadge.label}
                </span>
              </div>
            </div>

            <button
              type="button"
              onclick={() => enqueueAllLeadsForExperiment(0, false)}
              class="shrink-0 inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200"
              title="Enfileira TODOS os leads com telefone para o Experimento de 7 dias"
            >
              🧪 Enfileirar Todos ({totalLeadsWithPhone} Leads)
            </button>
          </div>

          <!-- CRM, Phone Filter & WhatsApp Mode Toggles -->
          <div class="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-gray-100 text-xs">
            <div class="flex flex-wrap items-center gap-2">
              <label class="inline-flex items-center cursor-pointer select-none bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-100">
                <input type="checkbox" bind:checked={onlyWhatsApp} class="rounded border-gray-300 text-indigo-600 mr-1.5" />
                <span class="font-semibold text-gray-700">📱 Apenas com Telefone</span>
              </label>

              <label class="inline-flex items-center cursor-pointer select-none bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-100">
                <input type="checkbox" bind:checked={hideContactedOrArchived} class="rounded border-gray-300 text-indigo-600 mr-1.5" />
                <span class="font-semibold text-gray-700">🙈 Ocultar já Contatados</span>
              </label>

              <label class="inline-flex items-center cursor-pointer select-none bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-200 hover:bg-amber-100">
                <input type="checkbox" bind:checked={onlyStarred} class="rounded border-amber-300 text-amber-600 mr-1.5" />
                <span class="font-semibold text-amber-800">⭐ Apenas Em Negociação</span>
              </label>
            </div>

            <!-- WhatsApp Mode Selector: API Background (0 Tabs) vs App vs Web -->
            <div class="inline-flex items-center bg-green-50 p-1 rounded-lg border border-green-200">
              <span class="text-[11px] font-semibold text-green-800 px-2">Modo WA:</span>
              <button
                type="button"
                onclick={() => setWhatsAppMode('api')}
                title="Envia em segundo plano via API sem abrir NENHUMA aba no navegador!"
                class="px-2 py-1 rounded text-[11px] font-semibold transition-colors {whatsappMode === 'api' ? 'bg-green-600 text-white shadow-sm' : 'text-green-800 hover:bg-green-100'}"
              >
                🚀 API Direto (0 Abas)
              </button>
              <button
                type="button"
                onclick={() => setWhatsAppMode('app')}
                title="Abre no aplicativo WhatsApp Desktop do Windows (se instalado)"
                class="px-2 py-1 rounded text-[11px] font-semibold transition-colors {whatsappMode === 'app' ? 'bg-green-600 text-white shadow-sm' : 'text-green-800 hover:bg-green-100'}"
              >
                ⚡ App Windows
              </button>
              <button
                type="button"
                onclick={() => setWhatsAppMode('web')}
                title="Abre no WhatsApp Web do navegador"
                class="px-2 py-1 rounded text-[11px] font-semibold transition-colors {whatsappMode === 'web' ? 'bg-green-600 text-white shadow-sm' : 'text-green-800 hover:bg-green-100'}"
              >
                🌐 Web
              </button>
            </div>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          {#each sortAndFilterLeads(currentGroup.leads) as lead, index}
            {@const leadKey = getLeadKey(lead.edital_id, lead.osc.cnpj)}
            {@const crmInfo = crmState[leadKey]}
            {@const activeMode = messageModeByCard[leadKey] || 'initial'}
            {@const activeMsgText = getActiveMessage(lead)}
            {@const inQueue = autoQueue.some(q => q.key === leadKey)}
            {@const phoneKind = getPhoneType(lead)}

            <div class="bg-white rounded-xl shadow-sm border {crmInfo?.status === 'negotiating' ? 'border-amber-400 ring-2 ring-amber-100' : crmInfo?.status === 'contacted' ? 'border-green-200 opacity-85' : 'border-gray-200'} overflow-hidden transition-all">
              <div class="p-5 border-b border-gray-100 flex justify-between items-start gap-4">
                <div>
                  <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-lg font-bold text-gray-900">{lead.osc.nome}</h3>
                    {#if crmInfo?.status === 'contacted'}
                      <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                        ✓ Contatado em {crmInfo.updatedAt}
                      </span>
                    {:else if crmInfo?.status === 'negotiating'}
                      <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                        ⭐ Em Negociação
                      </span>
                    {/if}
                  </div>
                  <p class="text-sm text-gray-500 mt-1">📍 {lead.osc.municipio}, {lead.osc.uf} • CNPJ: {lead.osc.cnpj} • Fundada em {lead.osc.ano_fundacao || 'N/A'}</p>

                  <!-- Quick Research & Cross-Sell Links -->
                  <div class="flex flex-wrap items-center gap-2 mt-2.5">
                    <a
                      href="/?cnpj={lead.osc.cnpj}"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200"
                      title="Abrir todos os editais compatíveis com esta ONG no Match Receptivo"
                    >
                      🔍 Ver Todos os Editais p/ esta ONG ↗
                    </a>
                    <a
                      href="https://www.google.com/search?q={encodeURIComponent(`${lead.osc.nome} ${lead.osc.municipio} instagram`)}"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-pink-50 text-pink-700 hover:bg-pink-100 border border-pink-200"
                    >
                      📸 Buscar Instagram / Web ↗
                    </a>
                  </div>
                </div>

                <div class="flex flex-col items-end space-y-2 shrink-0">
                  <span class="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold {getScoreColor(lead.score)}">
                    Match: {lead.score}%
                  </span>
                  {#if phoneKind === 'mobile'}
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-800 border border-green-200">
                      📱 Celular WhatsApp
                    </span>
                  {:else if phoneKind === 'landline'}
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                      ☎️ Fixo (Possível WA Business)
                    </span>
                  {:else}
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
                      ⚠️ Sem Telefone
                    </span>
                  {/if}
                </div>
              </div>

              <div class="p-5 space-y-4">
                <div>
                  <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Por que é um bom match?</h4>
                  <p class="text-gray-700 text-sm">{lead.motivo_match}</p>
                </div>

                <div class="bg-gray-50 p-3.5 rounded-lg border border-gray-100 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    {#if lead.contatos_encontrados?.whatsapp}
                      <span class="text-green-700 font-medium">📱 WhatsApp: {lead.contatos_encontrados.whatsapp}</span>
                    {:else if lead.osc?.official_contacts?.ddd_telefone_1}
                      <span class="text-gray-700">📱 Tel Oficial: {lead.osc.official_contacts.ddd_telefone_1}</span>
                    {:else}
                      <span class="text-gray-400">📱 Telefone: Não disponível</span>
                    {/if}
                  </div>
                  <div>
                    {#if lead.contatos_encontrados?.email}
                      <span class="text-blue-700">📧 {lead.contatos_encontrados.email}</span>
                    {:else if lead.osc?.official_contacts?.email}
                      <span class="text-gray-700">📧 {lead.osc.official_contacts.email}</span>
                    {:else}
                      <span class="text-gray-400">📧 Email: Não disponível</span>
                    {/if}
                  </div>
                </div>

                <!-- Message Mode Switcher -->
                <div>
                  <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Abordagem WhatsApp</h4>
                    <div class="flex flex-wrap gap-1">
                      {#each [
                        { id: 'opener', label: '🛡️ 1º Contato Curto (Anti-Ban)' },
                        { id: 'initial', label: '💬 Pitch Completo' },
                        { id: 'followup', label: '⏰ Follow-up (Urgência)' },
                        { id: 'audio', label: '🎙️ Roteiro Áudio (25s)' }
                      ] as m}
                        <button
                          class="px-2.5 py-1 rounded text-xs font-medium transition-colors {activeMode === m.id ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}"
                          onclick={() => { messageModeByCard = { ...messageModeByCard, [leadKey]: m.id as any }; }}
                        >
                          {m.label}
                        </button>
                      {/each}
                    </div>
                  </div>
                  <textarea
                    class="w-full text-sm text-gray-700 p-3 border border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 shadow-sm"
                    rows="4"
                    value={activeMsgText}
                    oninput={(e) => { lead.whatsapp_message = (e.target as HTMLTextAreaElement).value; }}
                  ></textarea>
                </div>

                <!-- Action Bar + CRM Status Controls -->
                <div class="flex flex-wrap justify-between items-center gap-3 pt-2 border-t border-gray-100">
                  <div class="flex items-center space-x-2">
                    <button
                      class="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                      onclick={() => toggleDossier(index)}
                    >
                      {openDossierIndex === index ? '▲ Ocultar Dossiê' : '▼ Ver Dossiê Completo'}
                    </button>
                    <span class="text-gray-300">|</span>
                    <button
                      class="px-2 py-1 rounded text-xs font-medium {crmInfo?.status === 'negotiating' ? 'bg-amber-200 text-amber-900' : 'bg-gray-100 text-gray-600 hover:bg-amber-50'}"
                      onclick={() => setLeadStatus(lead.edital_id, lead.osc.cnpj, crmInfo?.status === 'negotiating' ? 'pending' : 'negotiating')}
                    >
                      ⭐ {crmInfo?.status === 'negotiating' ? 'Em Negociação' : 'Favoritar'}
                    </button>
                    <button
                      class="px-2 py-1 rounded text-xs font-medium {crmInfo?.status === 'contacted' ? 'bg-green-200 text-green-900' : 'bg-gray-100 text-gray-600 hover:bg-green-50'}"
                      onclick={() => setLeadStatus(lead.edital_id, lead.osc.cnpj, crmInfo?.status === 'contacted' ? 'pending' : 'contacted')}
                    >
                      ✅ {crmInfo?.status === 'contacted' ? 'Contatado' : 'Marcar Contatado'}
                    </button>
                    <button
                      class="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-600"
                      onclick={() => setLeadStatus(lead.edital_id, lead.osc.cnpj, 'archived')}
                      title="Arquivar este lead"
                    >
                      🗑️
                    </button>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    {#if lead.edital_url}
                      <a
                        href={lead.edital_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-xs font-semibold rounded-md text-gray-700 bg-white hover:bg-gray-50"
                      >
                        📄 Ver Edital
                      </a>
                    {/if}
                    <button
                      type="button"
                      onclick={() => copyMessageOnly(lead, activeMsgText)}
                      class="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-xs font-semibold rounded-md text-gray-700 bg-white hover:bg-gray-50"
                      title="Copiar texto da mensagem para a área de transferência"
                    >
                      {copiedFeedbackKey === leadKey ? '✓ Copiado!' : '📋 Copiar'}
                    </button>
                    {#if hasAnyPhone(lead)}
                      <button
                        type="button"
                        disabled={inQueue}
                        onclick={() => addLeadToAutoQueue(lead, activeMsgText)}
                        class="inline-flex items-center px-3 py-2 border text-xs font-semibold rounded-md transition-colors {inQueue ? 'bg-indigo-50 text-indigo-400 border-indigo-100 cursor-default' : 'border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100'}"
                        title="Enfileirar para envio automático no horário comercial (09h–17h30)"
                      >
                        {inQueue ? '🕒 Na Fila' : '🤖 + Fila'}
                      </button>
                    {/if}
                    {#if getWhatsAppLink(lead, activeMsgText)}
                      <a
                        href={getWhatsAppLink(lead, activeMsgText)}
                        target="whatsapp_triade"
                        onclick={(e) => openWhatsAppSmart(e, lead, activeMsgText, true)}
                        class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-xs font-semibold rounded-md text-white bg-green-600 hover:bg-green-700"
                      >
                        {#if directSendFeedbackKey === leadKey}
                          ✓ Enviado s/ Abrir Aba!
                        {:else}
                          <span class="mr-1.5">{whatsappMode === 'api' ? '🚀' : whatsappMode === 'app' ? '⚡' : '💬'}</span>
                          Enviar WhatsApp {whatsappMode === 'api' ? '(0 Abas)' : whatsappMode === 'app' ? '(App)' : '(Web)'}
                        {/if}
                      </a>
                    {:else}
                      <button
                        disabled
                        class="inline-flex items-center px-3 py-2 border border-gray-200 text-xs font-medium rounded-md text-gray-400 bg-gray-100 cursor-not-allowed"
                      >
                        WhatsApp Indisponível
                      </button>
                    {/if}
                  </div>
                </div>

                {#if openDossierIndex === index}
                  <div class="mt-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <div class="prose prose-sm max-w-none text-gray-700">
                      {@html DOMPurify.sanitize(marked.parse(lead.dossieText || '*Dossiê não disponível*') as string)}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="flex-1 flex items-center justify-center text-gray-500">
          Selecione um edital à esquerda.
        </div>
      {/if}
    {:else if activeTab === 'manual'}
      <!-- Manual Search Results -->
      <div class="p-5 bg-white border-b border-gray-200 shadow-sm z-10 shrink-0 flex flex-wrap justify-between items-center gap-3">
        <h2 class="text-lg font-bold text-gray-800">Resultados da Busca Manual</h2>
        <div class="flex items-center gap-3">
          <label class="inline-flex items-center cursor-pointer select-none bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200 text-xs">
            <input type="checkbox" bind:checked={onlyWhatsApp} class="rounded border-gray-300 text-indigo-600 mr-1.5" />
            <span class="font-semibold text-gray-700">📱 Apenas com Telefone</span>
          </label>
          <div class="inline-flex items-center bg-green-50 p-1 rounded-lg border border-green-200 text-xs">
            <button
              type="button"
              onclick={() => setWhatsAppMode('api')}
              class="px-2 py-1 rounded text-[11px] font-semibold transition-colors {whatsappMode === 'api' ? 'bg-green-600 text-white shadow-sm' : 'text-green-800 hover:bg-green-100'}"
            >
              🚀 API (0 Abas)
            </button>
            <button
              type="button"
              onclick={() => setWhatsAppMode('app')}
              class="px-2 py-1 rounded text-[11px] font-semibold transition-colors {whatsappMode === 'app' ? 'bg-green-600 text-white shadow-sm' : 'text-green-800 hover:bg-green-100'}"
            >
              ⚡ App
            </button>
            <button
              type="button"
              onclick={() => setWhatsAppMode('web')}
              class="px-2 py-1 rounded text-[11px] font-semibold transition-colors {whatsappMode === 'web' ? 'bg-green-600 text-white shadow-sm' : 'text-green-800 hover:bg-green-100'}"
            >
              🌐 Web
            </button>
          </div>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-6 space-y-6">
        {#if manualSearchResults.length === 0 && !manualSearchLoading}
          <div class="flex flex-col items-center justify-center text-gray-500 h-full space-y-2">
            <p class="font-medium">Escolha qualquer um dos {bancoEditais.length} editais abertos à esquerda (ou cole o link de um PDF) e clique em Prospectar.</p>
          </div>
        {:else}
          {#each manualSearchResults as lead, index}
            {#if lead.loading}
              <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-pulse flex justify-between items-center">
                <div>
                  <div class="h-4 bg-gray-200 rounded w-48 mb-2"></div>
                  <div class="h-3 bg-gray-200 rounded w-32"></div>
                </div>
                <div class="h-6 w-24 bg-indigo-100 rounded-full"></div>
              </div>
            {:else if lead.error}
              <div class="bg-red-50 rounded-xl shadow-sm border border-red-200 p-6 text-red-700">
                <h3 class="font-bold">{lead.osc?.nome || 'OSC'}</h3>
                <p class="text-sm mt-1">{lead.error}</p>
              </div>
            {:else if lead.evaluated && (!onlyWhatsApp || hasAnyPhone(lead))}
              <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div class="p-5 border-b border-gray-100 flex justify-between items-start">
                  <div>
                    <h3 class="text-lg font-bold text-gray-900">{lead.osc.nome}</h3>
                    <p class="text-sm text-gray-500 mt-1">📍 {lead.osc.municipio}, {lead.osc.uf} • CNPJ: {lead.osc.cnpj}</p>
                    <div class="flex flex-wrap items-center gap-2 mt-2">
                      <a
                        href="/?cnpj={lead.osc.cnpj}"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200"
                      >
                        🔍 Ver Todos os Editais p/ esta ONG ↗
                      </a>
                      <a
                        href="https://www.google.com/search?q={encodeURIComponent(`${lead.osc.nome} ${lead.osc.municipio} instagram`)}"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-pink-50 text-pink-700 hover:bg-pink-100 border border-pink-200"
                      >
                        📸 Buscar Instagram / Web ↗
                      </a>
                    </div>
                  </div>
                  <div class="flex flex-col items-end space-y-2">
                    <span class="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold {getScoreColor(lead.score)}">
                      Match: {lead.score}%
                    </span>
                    {#if hasAnyPhone(lead)}
                      <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                        📱 Com Telefone
                      </span>
                    {/if}
                  </div>
                </div>
                <div class="p-5 space-y-4">
                  <div>
                    <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Por que é um bom match?</h4>
                    <p class="text-gray-700 text-sm">{lead.motivo_match}</p>
                  </div>
                  <div>
                    <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Mensagem Sugerida</h4>
                    <textarea
                      class="w-full text-sm text-gray-700 p-3 border border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 shadow-sm"
                      rows="4"
                      bind:value={lead.whatsapp_message}
                    ></textarea>
                  </div>
                  <div class="flex justify-between items-center pt-2">
                    <button
                      class="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                      onclick={() => toggleDossier(index + 1000)}
                    >
                      {openDossierIndex === (index + 1000) ? '▲ Ocultar Dossiê' : '▼ Ver Dossiê Completo'}
                    </button>
                    <div class="flex space-x-2">
                      {#if lead.edital_url}
                        <a
                          href={lead.edital_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-xs font-semibold rounded-md text-gray-700 bg-white hover:bg-gray-50"
                        >
                          📄 Ver Edital
                        </a>
                      {/if}
                      {#if getWhatsAppLink(lead, lead.whatsapp_message)}
                        <a
                          href={getWhatsAppLink(lead, lead.whatsapp_message)}
                          target="whatsapp_triade"
                          onclick={(e) => openWhatsAppSmart(e, lead, lead.whatsapp_message, false)}
                          class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-xs font-semibold rounded-md text-white bg-green-600 hover:bg-green-700"
                        >
                          <span class="mr-1.5">{whatsappMode === 'api' ? '🚀' : whatsappMode === 'app' ? '⚡' : '💬'}</span>
                          Enviar WhatsApp {whatsappMode === 'api' ? '(0 Abas)' : whatsappMode === 'app' ? '(App)' : '(Web)'}
                        </a>
                      {/if}
                    </div>
                  </div>
                  {#if openDossierIndex === (index + 1000)}
                    <div class="mt-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                      <div class="prose prose-sm max-w-none text-gray-700">
                        {@html DOMPurify.sanitize(marked.parse(lead.dossieText || '*Dossiê não disponível*') as string)}
                      </div>
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          {/each}
        {/if}
      </div>
    {:else}
      <!-- Right Pane for Automation Tab: 7-Day Experiment Analytics + Queue + AI SDR Simulator -->
      <div class="flex-1 overflow-y-auto p-6 space-y-6">
        <!-- Section 0: 7-Day Experiment Telemetry & CSV Export -->
        <div class="bg-white rounded-xl shadow-sm border border-purple-200 p-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 class="text-sm font-bold text-purple-900">📊 Telemetria do Experimento de 7 Dias (Todos os Leads)</h3>
              <p class="text-xs text-gray-600">
                Acompanhe quantos e quais perfis de OSCs recebem e respondem às mensagens da Angela para calibrar o funil.
              </p>
            </div>
            <button
              type="button"
              disabled={autoQueue.length === 0}
              onclick={exportExperimentCsv}
              class="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 text-white hover:bg-purple-700 disabled:bg-gray-300"
            >
              📥 Exportar CSV p/ Análise
            </button>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-center">
            <div class="p-2.5 rounded-lg bg-gray-50 border border-gray-200">
              <div class="text-lg font-extrabold text-gray-900">{autoQueue.length}</div>
              <div class="text-[11px] text-gray-500 font-medium">Na Fila Total</div>
            </div>
            <div class="p-2.5 rounded-lg bg-green-50 border border-green-200">
              <div class="text-lg font-extrabold text-green-700">{autoQueue.filter(i => i.phoneType === 'mobile').length}</div>
              <div class="text-[11px] text-green-800 font-medium">📱 Celulares</div>
            </div>
            <div class="p-2.5 rounded-lg bg-blue-50 border border-blue-200">
              <div class="text-lg font-extrabold text-blue-700">{autoQueue.filter(i => i.phoneType === 'landline').length}</div>
              <div class="text-[11px] text-blue-800 font-medium">☎️ Fixos (WA Bus.)</div>
            </div>
            <div class="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200">
              <div class="text-lg font-extrabold text-indigo-700">{sentQueueItems.length}</div>
              <div class="text-[11px] text-indigo-800 font-medium">✅ Já Enviados</div>
            </div>
            <div class="p-2.5 rounded-lg bg-amber-50 border border-amber-200">
              <div class="text-lg font-extrabold text-amber-700">
                {repliedQueueItems.length}
                {#if sentQueueItems.length > 0}
                  <span class="text-xs font-normal">({Math.round((repliedQueueItems.length / sentQueueItems.length) * 100)}%)</span>
                {/if}
              </div>
              <div class="text-[11px] text-amber-800 font-medium">💬 Respostas IA</div>
            </div>
          </div>
        </div>

        <!-- Section 1: Business-Hours Queue -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div class="p-4 border-b border-gray-100 flex flex-wrap justify-between items-center gap-2 bg-gray-50">
            <div>
              <h3 class="text-base font-bold text-gray-900">🕒 Fila de Disparo em Horário Comercial ({autoQueue.length})</h3>
              <p class="text-xs text-gray-500">
                Prioriza automaticamente celulares móveis primeiro e depois telefones fixos comerciais.
              </p>
            </div>
            <div class="flex gap-2">
              {#if autoQueue.some(i => i.status === 'sent')}
                <button
                  type="button"
                  onclick={clearSentFromQueue}
                  class="px-2.5 py-1 rounded text-xs font-medium bg-white border border-gray-300 text-gray-600 hover:bg-gray-100"
                >
                  Limpar Enviados
                </button>
              {/if}
              {#if autoQueue.length > 0}
                <button
                  type="button"
                  onclick={() => { autoQueue = []; saveQueue(); }}
                  class="px-2.5 py-1 rounded text-xs font-medium bg-white border border-red-200 text-red-600 hover:bg-red-50"
                >
                  Esvaziar Fila
                </button>
              {/if}
            </div>
          </div>

          <div class="divide-y divide-gray-100 max-h-72 overflow-y-auto">
            {#if autoQueue.length === 0}
              <div class="p-6 text-center text-xs text-gray-500">
                Nenhuma ONG na fila. Clique em <strong>"🧪 Enfileirar TODOS os Leads ({totalLeadsWithPhone} ONGs)"</strong> à esquerda para carregar todos os leads para o experimento!
              </div>
            {:else}
              {#each autoQueue as item}
                <div class="p-3.5 flex items-center justify-between gap-3 text-xs">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-bold text-gray-900 truncate">{item.lead.osc?.nome}</span>
                      <span class="text-gray-400">•</span>
                      <span class="text-gray-600 font-mono">+{item.phone}</span>
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold {item.phoneType === 'mobile' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}">
                        {item.phoneType === 'mobile' ? '📱 Celular' : '☎️ Fixo'}
                      </span>
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-bold {getScoreColor(item.lead.score)}">
                        {item.lead.score}%
                      </span>
                      {#if item.replyIntent}
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800">
                          Respondeu: {item.replyIntent}
                        </span>
                      {/if}
                    </div>
                    <p class="text-gray-500 truncate mt-0.5">{item.message}</p>
                  </div>

                  <div class="flex items-center gap-2 shrink-0">
                    {#if item.status === 'waiting_hours'}
                      <span class="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-semibold">
                        🌙 Aguardando 09h00 BRT
                      </span>
                    {:else if item.status === 'queued'}
                      <span class="px-2.5 py-1 rounded-full bg-blue-100 text-blue-800 font-semibold">
                        ⏳ Na Fila
                      </span>
                    {:else if item.status === 'sending'}
                      <span class="px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-800 font-semibold animate-pulse">
                        💬 Digitando e Enviando...
                      </span>
                    {:else if item.status === 'sent'}
                      <span class="px-2.5 py-1 rounded-full bg-green-100 text-green-800 font-semibold">
                        ✓ Enviado às {item.sentAt}
                      </span>
                    {:else if item.status === 'error'}
                      <span class="px-2.5 py-1 rounded-full bg-red-100 text-red-800 font-semibold" title={item.error}>
                        ⚠️ {item.error || 'Erro'}
                      </span>
                    {/if}
                    <button
                      type="button"
                      onclick={() => removeQueueItem(item.key)}
                      class="text-gray-400 hover:text-red-600 px-1"
                      title="Remover da fila"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <!-- Section 2: Interactive AI SDR Auto-Responder Simulator -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div class="p-4 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-teal-50">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="text-base font-bold text-gray-900">🧠 Agente IA SDR — Analisador e Respondedor de WhatsApp</h3>
                <p class="text-xs text-gray-600">
                  Simule ou teste como o Assistente de IA da Maria Angela identifica a intenção da ONG, mantém o nome do edital em segredo, responde dúvidas e notifica a Angela!
                </p>
              </div>
              <button
                type="button"
                onclick={() => { sdrConversation = []; }}
                class="px-2.5 py-1 rounded text-xs font-medium bg-white border border-gray-300 text-gray-600 hover:bg-gray-100"
              >
                Limpar Chat
              </button>
            </div>

            <div class="mt-3">
              <label class="block text-xs font-semibold text-gray-700 mb-1">ONG em conversa (Contexto do Edital + Dossiê):</label>
              <select
                bind:value={sdrSelectedLeadKey}
                class="w-full px-3 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
              >
                {#each leads.slice(0, 60) as l}
                  <option value={getLeadKey(l.edital_id, l.osc?.cnpj)}>
                    [{l.score}%] {l.osc?.nome} ({l.osc?.municipio}/{l.osc?.uf}) — Edital: {formatCurrency(l.edital_valor)}
                  </option>
                {/each}
              </select>
            </div>

            <!-- Preset Quick Replies from NGO -->
            <div class="mt-3 flex flex-wrap gap-1.5">
              <span class="text-[11px] font-semibold text-gray-600 self-center mr-1">Testar resposta rápida da ONG:</span>
              {#each [
                'Olá! Pode enviar o resumo sim, temos interesse!',
                'Qual é o nome desse edital e qual instituição está financiando?',
                'Qual é o valor máximo, o prazo e como funciona a consultoria de vocês?',
                'Não temos interesse no momento, obrigado.'
              ] as preset}
                <button
                  type="button"
                  disabled={sdrLoading}
                  onclick={() => simulateIncomingOngReply(preset)}
                  class="px-2.5 py-1 rounded-full text-[11px] font-medium bg-white border border-emerald-300 text-emerald-800 hover:bg-emerald-100 transition-colors"
                >
                  "{preset.slice(0, 45)}{preset.length > 45 ? '...' : ''}"
                </button>
              {/each}
            </div>
          </div>

          <!-- Chat History Area -->
          <div class="p-4 bg-gray-50 space-y-3 max-h-96 overflow-y-auto">
            {#if sdrConversation.length === 0 && !sdrLoading}
              <div class="text-center py-6 text-xs text-gray-500">
                Clique em um dos botões de teste acima ou digite uma mensagem abaixo como se você fosse a ONG respondendo no WhatsApp.
              </div>
            {/if}

            {#each sdrConversation as msg}
              {#if msg.role === 'ong'}
                <div class="flex justify-start">
                  <div class="max-w-lg bg-white border border-gray-200 rounded-2xl rounded-tl-none px-4 py-2.5 shadow-sm text-xs">
                    <div class="font-bold text-gray-700 mb-0.5">🏢 Resposta da ONG ({msg.timestamp})</div>
                    <p class="text-gray-800 whitespace-pre-line">{msg.text}</p>
                  </div>
                </div>
              {:else}
                <div class="flex justify-end">
                  <div class="max-w-xl bg-emerald-50 border border-emerald-200 rounded-2xl rounded-tr-none px-4 py-3 shadow-sm text-xs space-y-2">
                    {#if msg.meta}
                      <div class="flex flex-wrap items-center gap-1.5 pb-1.5 border-b border-emerald-200">
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-700 text-white">
                          {msg.meta.intent_label || msg.meta.intent}
                        </span>
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white text-emerald-800 border border-emerald-300">
                          CRM → {msg.meta.crm_status}
                        </span>
                        <span class="text-[11px] text-emerald-900 font-medium">
                          {msg.meta.analysis}
                        </span>
                      </div>
                    {/if}
                    <div>
                      <div class="font-bold text-emerald-900 mb-0.5">🤖 Resposta Automática IA Triade ({msg.timestamp}):</div>
                      <p class="text-gray-800 whitespace-pre-line">{msg.text}</p>
                    </div>
                    {#if msg.meta?.should_notify_angela && msg.meta?.angela_alert}
                      <div class="p-2 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                        <strong>📲 Alerta enviado ao celular da Maria Angela:</strong><br />
                        {msg.meta.angela_alert}
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}
            {/each}

            {#if sdrLoading}
              <div class="flex justify-end">
                <div class="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-2.5 text-xs text-emerald-800 animate-pulse font-medium">
                  🧠 Gemini 2.5 analisando intenção, consultando edital e redigindo resposta...
                </div>
              </div>
            {/if}
          </div>

          <!-- Input Bar -->
          <form
            onsubmit={(e) => { e.preventDefault(); simulateIncomingOngReply(); }}
            class="p-3 bg-white border-t border-gray-200 flex gap-2"
          >
            <input
              type="text"
              bind:value={sdrIncomingInput}
              placeholder="Digite aqui uma resposta ou pergunta da ONG para testar a IA..."
              class="flex-1 px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              type="submit"
              disabled={sdrLoading || !sdrIncomingInput.trim()}
              class="px-4 py-2 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300"
            >
              Simular Resposta da ONG ➔
            </button>
          </form>
        </div>
      </div>
    {/if}
  </div>
</div>
