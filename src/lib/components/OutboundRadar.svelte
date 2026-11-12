<script lang="ts">
  import { onMount } from 'svelte';
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
  let minDaysFilter = 15; // Default: only show editais with >= 15 days left (or continuous flow)

  // Message Template Mode per card: 'initial' | 'followup' | 'audio'
  let messageModeByCard: Record<string, 'initial' | 'followup' | 'audio'> = {};

  onMount(() => {
    try {
      const saved = localStorage.getItem('triade_outbound_crm_v1');
      if (saved) {
        crmState = JSON.parse(saved);
      }
    } catch {
      crmState = {};
    }
  });

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

  let openDossierIndex: number | null = null;

  // Manual Search State
  let activeTab: 'daily' | 'manual' = 'daily';
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

  function hasDirectWhatsApp(lead: any): boolean {
    return !!lead.contatos_encontrados?.whatsapp;
  }

  function hasAnyPhone(lead: any): boolean {
    return !!getCleanPhoneNumber(lead);
  }

  function getActiveMessage(lead: any): string {
    const key = getLeadKey(lead.edital_id, lead.osc?.cnpj);
    const mode = messageModeByCard[key] || 'initial';
    const valorStr = lead.edital_valor ? formatCurrency(lead.edital_valor) : 'valor expressivo';
    const prazoStr = lead.dias_restantes ? `faltam apenas ${lead.dias_restantes} dias para o encerramento` : 'as inscrições estão abertas';

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
    return `https://wa.me/55${cleanPhone}?text=${encodeURIComponent(message || '')}`;
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
      // Always hide archived unless unfiltered
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
  <!-- Left Pane: Editais List / Manual Search Form -->
  <div class="w-1/3 bg-white border-r border-gray-200 flex flex-col h-full">
    <div class="p-5 border-b border-gray-200">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-gray-900">Radar de Prospecção</h1>
        <span class="text-xs font-medium px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700">
          {bancoEditais.length} editais ativos
        </span>
      </div>

      <!-- Tabs -->
      <div class="flex space-x-4 mt-4 border-b border-gray-200">
        <button
          class="pb-2 text-sm font-medium {activeTab === 'daily' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500 hover:text-gray-700'}"
          onclick={() => { activeTab = 'daily'; }}
        >
          Pipeline Diário
        </button>
        <button
          class="pb-2 text-sm font-medium {activeTab === 'manual' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500 hover:text-gray-700'}"
          onclick={() => { activeTab = 'manual'; }}
        >
          Nova Busca Manual ({bancoEditais.length})
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
      {:else}
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
      {/if}
    </div>
  </div>

  <!-- Right Pane: Leads Feed -->
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
          </div>

          <!-- CRM & Phone Filter Toggles -->
          <div class="flex flex-wrap items-center gap-3 pt-1 border-t border-gray-100 text-xs">
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
        </div>

        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          {#each sortAndFilterLeads(currentGroup.leads) as lead, index}
            {@const leadKey = getLeadKey(lead.edital_id, lead.osc.cnpj)}
            {@const crmInfo = crmState[leadKey]}
            {@const activeMode = messageModeByCard[leadKey] || 'initial'}
            {@const activeMsgText = getActiveMessage(lead)}

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
                  {#if hasDirectWhatsApp(lead)}
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                      ✓ WhatsApp no Dossiê
                    </span>
                  {:else if hasAnyPhone(lead)}
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                      📞 Telefone Oficial
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
                  <div class="flex items-center justify-between mb-2">
                    <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Abordagem WhatsApp</h4>
                    <div class="flex space-x-1">
                      {#each [
                        { id: 'initial', label: '💬 1º Contato' },
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
                    {#if getWhatsAppLink(lead, activeMsgText)}
                      <a
                        href={getWhatsAppLink(lead, activeMsgText)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onclick={() => setLeadStatus(lead.edital_id, lead.osc.cnpj, 'contacted')}
                        class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-xs font-semibold rounded-md text-white bg-green-600 hover:bg-green-700"
                      >
                        <span class="mr-1.5">💬</span> Enviar WhatsApp
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
    {:else}
      <!-- Manual Search Results -->
      <div class="p-5 bg-white border-b border-gray-200 shadow-sm z-10 shrink-0 flex justify-between items-center">
        <h2 class="text-lg font-bold text-gray-800">Resultados da Busca Manual</h2>
        <label class="inline-flex items-center cursor-pointer select-none bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200 text-xs">
          <input type="checkbox" bind:checked={onlyWhatsApp} class="rounded border-gray-300 text-indigo-600 mr-1.5" />
          <span class="font-semibold text-gray-700">📱 Apenas com Telefone</span>
        </label>
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
                          target="_blank"
                          rel="noopener noreferrer"
                          class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-xs font-semibold rounded-md text-white bg-green-600 hover:bg-green-700"
                        >
                          💬 Enviar WhatsApp
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
    {/if}
  </div>
</div>
