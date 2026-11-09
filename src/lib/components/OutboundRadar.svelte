<script lang="ts">
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';

  export let leads: any[] = [];

  // Group leads by Edital
  let groupedLeads: Record<string, any> = {};
  $: {
    groupedLeads = leads.reduce((acc, lead) => {
      if (!acc[lead.edital_id]) {
        acc[lead.edital_id] = {
          titulo: lead.edital_titulo,
          leads: []
        };
      }
      acc[lead.edital_id].leads.push(lead);
      return acc;
    }, {});
  }

  let selectedEditalId: string | null = null;
  $: if (!selectedEditalId && Object.keys(groupedLeads).length > 0) {
    selectedEditalId = Object.keys(groupedLeads)[0];
  }

  let openDossierIndex: number | null = null;

  // Manual Search State
  let activeTab: 'daily' | 'manual' = 'daily';
  let editalSource: 'banco' | 'link' = 'banco';
  let manualSearchPdfUrl = '';
  let manualSearchKeywords = '';
  let manualSearchEditalId = '';
  let manualSearchLoading = false;
  let manualSearchResults: any[] = [];
  let manualEvaluationProgress = '';

  function getScoreColor(score: number) {
    if (score >= 90) return 'text-green-600 bg-green-100';
    if (score >= 70) return 'text-yellow-600 bg-yellow-100';
    return 'text-red-600 bg-red-100';
  }

  function toggleDossier(index: number) {
    if (openDossierIndex === index) {
      openDossierIndex = null;
    } else {
      openDossierIndex = index;
    }
  }

  // WhatsApp Filter and Lead Quality State
  let onlyWhatsApp = false;

  function getCleanPhoneNumber(lead: any): string | null {
    const raw = lead.contatos_encontrados?.whatsapp || lead.osc?.official_contacts?.ddd_telefone_1 || lead.osc?.official_contacts?.ddd_telefone_2;
    if (!raw) return null;
    const digits = raw.toString().replace(/\D/g, '');
    if (digits.length < 10) return null;
    // Strip leading 55 if already present
    return digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
  }

  function hasDirectWhatsApp(lead: any): boolean {
    return !!lead.contatos_encontrados?.whatsapp;
  }

  function hasAnyPhone(lead: any): boolean {
    return !!getCleanPhoneNumber(lead);
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
    // Sort strictly by AI score (descending)
    return list.sort((a, b) => {
      return (b.score || 0) - (a.score || 0);
    });
  }

  async function performManualSearch() {
    if ((editalSource === 'banco' && !manualSearchEditalId) || (editalSource === 'link' && !manualSearchPdfUrl)) return;

    manualSearchLoading = true;
    manualSearchResults = [];
    manualEvaluationProgress = 'Iniciando busca (Fase 1 e 2)...';

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

      // Step A: Discover (Fetch top candidate OSCs)
      const discoverRes = await fetch('/api/outbound/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editalId: editalSource === 'banco' ? manualSearchEditalId : undefined,
          edital: parsedEdital,
          customKeywords: manualSearchKeywords.trim() || undefined
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

      // Initialize results with loading state
      manualSearchResults = topOscs.map((osc: any) => ({
        osc,
        loading: true,
        evaluated: false
      }));

      // Step B & C: Evaluate sequentially
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
            manualSearchResults[i] = { ...matchResult, loading: false, evaluated: true };
          } else {
            manualSearchResults[i].loading = false;
            manualSearchResults[i].error = 'Erro na avaliação da OSC';
          }
        } catch (e: any) {
          manualSearchResults[i].loading = false;
          manualSearchResults[i].error = e.message || 'Erro na requisição de avaliação';
        }

        // Force reactivity
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
    <div class="p-6 border-b border-gray-200">
      <h1 class="text-2xl font-bold text-gray-900">Radar de Prospecção</h1>

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
          Nova Busca Manual
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if activeTab === 'daily'}
        <!-- Daily Leads List -->
        {#each Object.entries(groupedLeads) as [id, data]}
          <button
            class="w-full text-left p-4 border-b border-gray-100 hover:bg-indigo-50 transition-colors {selectedEditalId === id ? 'bg-indigo-50 border-l-4 border-indigo-600' : 'border-l-4 border-transparent'}"
            onclick={() => { selectedEditalId = id; openDossierIndex = null; }}
          >
            <div class="flex justify-between items-start">
              <h3 class="font-medium text-gray-900 line-clamp-2 pr-4">{data.titulo}</h3>
              <span class="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                {data.leads.length} leads
              </span>
            </div>
          </button>
        {/each}
      {:else}
        <!-- Manual Search Form -->
        <div class="p-6 space-y-4">
          <div class="flex space-x-4 mb-4">
            <label class="inline-flex items-center">
              <input type="radio" bind:group={editalSource} value="banco" class="form-radio text-indigo-600 h-4 w-4" />
              <span class="ml-2 text-sm text-gray-700">Selecionar Edital do Banco</span>
            </label>
            <label class="inline-flex items-center">
              <input type="radio" bind:group={editalSource} value="link" class="form-radio text-indigo-600 h-4 w-4" />
              <span class="ml-2 text-sm text-gray-700">Inserir Link de Novo Edital (PDF)</span>
            </label>
          </div>

          {#if editalSource === 'banco'}
            <div>
              <label class="block text-sm font-medium text-gray-700">Edital</label>
              <select
                bind:value={manualSearchEditalId}
                class="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md border"
              >
                <option value="" disabled>Selecione um Edital...</option>
                {#each Object.entries(groupedLeads) as [id, data]}
                  <option value={id}>{data.titulo}</option>
                {/each}
              </select>
            </div>
          {:else}
            <div>
              <label class="block text-sm font-medium text-gray-700">Link do PDF do Edital</label>
              <input
                type="url"
                bind:value={manualSearchPdfUrl}
                placeholder="https://exemplo.com/edital.pdf"
                class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              />
            </div>
          {/if}

          <div>
            <label class="block text-sm font-medium text-gray-700">Palavras-chave Customizadas</label>
            <p class="text-xs text-gray-500 mt-1 mb-2">Ex: mulheres, quilombola, João Pessoa</p>
            <input
              type="text"
              bind:value={manualSearchKeywords}
              placeholder="Digite as palavras-chave..."
              class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
            />
          </div>

          <button
            onclick={performManualSearch}
            disabled={manualSearchLoading || (editalSource === 'banco' ? !manualSearchEditalId : !manualSearchPdfUrl)}
            class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-indigo-400"
          >
            {manualSearchLoading ? 'Buscando...' : 'Buscar OSCs'}
          </button>

          {#if manualSearchLoading || manualEvaluationProgress}
            <div class="mt-4 p-4 bg-blue-50 text-blue-700 text-sm rounded-md border border-blue-200">
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
        <div class="p-6 bg-white border-b border-gray-200 shadow-sm z-10 shrink-0 flex justify-between items-center">
          <div>
            <h2 class="text-xl font-semibold text-gray-800">
              Matches para: <span class="text-indigo-600">{groupedLeads[selectedEditalId].titulo}</span>
            </h2>
            <p class="text-xs text-gray-500 mt-1">
              Priorizando OSCs com contatos validados e prontos para abordagem via WhatsApp.
            </p>
          </div>
          <!-- Filter toggle -->
          <label class="inline-flex items-center cursor-pointer select-none bg-gray-50 px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-100 transition-colors">
            <input type="checkbox" bind:checked={onlyWhatsApp} class="rounded border-gray-300 text-indigo-600 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50 mr-2" />
            <span class="text-xs font-semibold text-gray-700">Apenas com Telefone/WhatsApp</span>
          </label>
        </div>

        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          {#each sortAndFilterLeads(groupedLeads[selectedEditalId].leads) as lead, index}
            <!-- Lead Card Component (extracted logically) -->
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div class="p-6 border-b border-gray-100 flex justify-between items-start">
                <div>
                  <h3 class="text-lg font-bold text-gray-900">{lead.osc.nome}</h3>
                  <p class="text-sm text-gray-500 mt-1">📍 {lead.osc.municipio}, {lead.osc.uf}</p>
                  <p class="text-xs text-gray-400 mt-1">CNPJ: {lead.osc.cnpj}</p>
                </div>
                <div class="flex flex-col items-end space-y-2">
                  <span class="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold {getScoreColor(lead.score)}">
                    Pontuação: {lead.score}
                  </span>
                  {#if hasDirectWhatsApp(lead)}
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                      ✓ WhatsApp Verificado
                    </span>
                  {:else if hasAnyPhone(lead)}
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                      📞 Telefone Oficial (CNPJ)
                    </span>
                  {:else}
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
                      ⚠️ Sem Telefone Cadastrado
                    </span>
                  {/if}
                </div>
              </div>
              <div class="p-6 space-y-4">
                <div>
                  <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Por que é um bom match?</h4>
                  <p class="text-gray-700 text-sm">{lead.motivo_match}</p>
                </div>
                <div class="bg-gray-50 p-4 rounded-lg border border-gray-100">
                  <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Contatos</h4>
                  <div class="grid grid-cols-2 gap-4 text-sm">
                    {#if lead.contatos_encontrados?.whatsapp}
                      <div class="flex items-center text-green-700 font-medium">
                        <span class="mr-2">📱</span> WhatsApp: {lead.contatos_encontrados.whatsapp}
                      </div>
                    {:else if lead.osc?.official_contacts?.ddd_telefone_1}
                      <div class="flex items-center text-gray-700">
                        <span class="mr-2">📱</span> Telefone (Oficial): {lead.osc.official_contacts.ddd_telefone_1}
                      </div>
                    {:else}
                      <div class="flex items-center text-gray-400">
                        <span class="mr-2">📱</span> Telefone: Não disponível
                      </div>
                    {/if}

                    {#if lead.contatos_encontrados?.email}
                      <div class="flex items-center text-blue-700">
                        <span class="mr-2">📧</span> {lead.contatos_encontrados.email}
                      </div>
                    {:else if lead.osc?.official_contacts?.email}
                       <div class="flex items-center text-gray-700">
                        <span class="mr-2">📧</span> Oficial: {lead.osc.official_contacts.email}
                      </div>
                    {:else}
                      <div class="flex items-center text-gray-400">
                        <span class="mr-2">📧</span> Email: Não disponível
                      </div>
                    {/if}
                  </div>
                </div>
                <div>
                   <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Mensagem Sugerida</h4>
                   <textarea
                     class="w-full text-sm text-gray-700 p-3 border border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 shadow-sm"
                     rows="4"
                     bind:value={lead.whatsapp_message}
                   ></textarea>
                </div>
                <div class="flex justify-between items-center pt-4">
                  <button
                    class="text-sm font-medium text-indigo-600 hover:text-indigo-800 focus:outline-none"
                    onclick={() => toggleDossier(index)}
                  >
                    {openDossierIndex === index ? '▲ Ocultar Dossiê' : '▼ Ver Dossiê Completo'}
                  </button>
                  <div class="flex space-x-3">
                    {#if getWhatsAppLink(lead, lead.whatsapp_message)}
                      <a
                        href={getWhatsAppLink(lead, lead.whatsapp_message)}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                      >
                        <span class="mr-2">💬</span> Enviar WhatsApp
                      </a>
                    {:else}
                      <button
                        disabled
                        title="Sem número de WhatsApp ou telefone registrado"
                        class="inline-flex items-center px-4 py-2 border border-gray-200 shadow-sm text-sm font-medium rounded-md text-gray-400 bg-gray-100 cursor-not-allowed"
                      >
                        <span class="mr-2">💬</span> WhatsApp Indisponível
                      </button>
                    {/if}
                  </div>
                </div>
                {#if openDossierIndex === index}
                  <div class="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
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
      <div class="p-6 bg-white border-b border-gray-200 shadow-sm z-10 shrink-0">
        <h2 class="text-xl font-semibold text-gray-800">Resultados da Busca Manual</h2>
      </div>
      <div class="flex-1 overflow-y-auto p-6 space-y-6">
        {#if manualSearchResults.length === 0 && !manualSearchLoading}
           <div class="flex items-center justify-center text-gray-500 h-full">
             Preencha os filtros e clique em buscar.
           </div>
        {:else}
          {#each manualSearchResults as lead, index}
            {#if lead.loading}
              <!-- Skeleton Loader -->
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
            {:else if lead.evaluated}
              <!-- Evaluated Lead Card -->
              <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div class="p-6 border-b border-gray-100 flex justify-between items-start">
                  <div>
                    <h3 class="text-lg font-bold text-gray-900">{lead.osc.nome}</h3>
                    <p class="text-sm text-gray-500 mt-1">📍 {lead.osc.municipio}, {lead.osc.uf}</p>
                    <p class="text-xs text-gray-400 mt-1">CNPJ: {lead.osc.cnpj}</p>
                  </div>
                  <div class="flex flex-col items-end space-y-2">
                    <span class="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold {getScoreColor(lead.score)}">
                      Pontuação: {lead.score}
                    </span>
                    {#if hasDirectWhatsApp(lead)}
                      <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                        ✓ WhatsApp Verificado
                      </span>
                    {:else if hasAnyPhone(lead)}
                      <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                        📞 Telefone Oficial (CNPJ)
                      </span>
                    {:else}
                      <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
                        ⚠️ Sem Telefone Cadastrado
                      </span>
                    {/if}
                  </div>
                </div>
                <div class="p-6 space-y-4">
                  <div>
                    <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Por que é um bom match?</h4>
                    <p class="text-gray-700 text-sm">{lead.motivo_match}</p>
                  </div>
                  <div class="bg-gray-50 p-4 rounded-lg border border-gray-100">
                    <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Contatos</h4>
                    <div class="grid grid-cols-2 gap-4 text-sm">
                      {#if lead.contatos_encontrados?.whatsapp}
                        <div class="flex items-center text-green-700 font-medium">
                          <span class="mr-2">📱</span> WhatsApp: {lead.contatos_encontrados.whatsapp}
                        </div>
                      {:else if lead.osc?.official_contacts?.ddd_telefone_1}
                        <div class="flex items-center text-gray-700">
                          <span class="mr-2">📱</span> Telefone (Oficial): {lead.osc.official_contacts.ddd_telefone_1}
                        </div>
                      {:else}
                        <div class="flex items-center text-gray-400">
                          <span class="mr-2">📱</span> Telefone: Não disponível
                        </div>
                      {/if}

                      {#if lead.contatos_encontrados?.email}
                        <div class="flex items-center text-blue-700">
                          <span class="mr-2">📧</span> {lead.contatos_encontrados.email}
                        </div>
                      {:else if lead.osc?.official_contacts?.email}
                         <div class="flex items-center text-gray-700">
                          <span class="mr-2">📧</span> Oficial: {lead.osc.official_contacts.email}
                        </div>
                      {:else}
                        <div class="flex items-center text-gray-400">
                          <span class="mr-2">📧</span> Email: Não disponível
                        </div>
                      {/if}
                    </div>
                  </div>
                  <div>
                     <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Mensagem Sugerida</h4>
                     <textarea
                       class="w-full text-sm text-gray-700 p-3 border border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 shadow-sm"
                       rows="4"
                       bind:value={lead.whatsapp_message}
                     ></textarea>
                  </div>
                  <div class="flex justify-between items-center pt-4">
                    <button
                      class="text-sm font-medium text-indigo-600 hover:text-indigo-800 focus:outline-none"
                      onclick={() => toggleDossier(index + 1000)}
                    >
                      {openDossierIndex === (index + 1000) ? '▲ Ocultar Dossiê' : '▼ Ver Dossiê Completo'}
                    </button>
                    <div class="flex space-x-3">
                      {#if getWhatsAppLink(lead, lead.whatsapp_message)}
                        <a
                          href={getWhatsAppLink(lead, lead.whatsapp_message)}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                        >
                          <span class="mr-2">💬</span> Enviar WhatsApp
                        </a>
                      {:else}
                        <button
                          disabled
                          title="Sem número de WhatsApp ou telefone registrado"
                          class="inline-flex items-center px-4 py-2 border border-gray-200 shadow-sm text-sm font-medium rounded-md text-gray-400 bg-gray-100 cursor-not-allowed"
                        >
                          <span class="mr-2">💬</span> WhatsApp Indisponível
                        </button>
                      {/if}
                    </div>
                  </div>
                  {#if openDossierIndex === (index + 1000)}
                    <div class="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
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
