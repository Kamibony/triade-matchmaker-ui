<script lang="ts">
  import { marked } from 'marked';

  let cnpj = $state('');
  let focoAtividades = $state('');
  let loading = $state(false);
  let results = $state<any[] | null>(null);
  let errorMsg = $state<string | null>(null);
  let deepDiveLoading = $state<Record<string, boolean>>({});
  let deepDiveReports = $state<Record<string, any>>({});
  let deepDiveErrors = $state<Record<string, string>>({});
  let oscDetails = $state<any>(null);
  let isDossierLoading = $state(false);
  let dossierResult = $state<string | null>(null);
  let dossierError = $state<string | null>(null);

  let ufState = $state('');
  let municipioState = $state('');
  let naturezaJuridicaState = $state('');
  let idadeAnosState = $state(0);
  let cnaeDataState = $state('');

  async function handleFetchMatches() {
    loading = true;
    errorMsg = null;
    results = null;

    try {
      const response = await fetch('/api/match', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cnpj,
          nome: oscDetails?.nome_fantasia || oscDetails?.razao_social || '',
          foco_atividades: focoAtividades,
          cnae_data: cnaeDataState,
          uf: ufState,
          municipio: municipioState,
          natureza_juridica: naturezaJuridicaState,
          idade_anos: idadeAnosState,
          dossier_text: dossierResult
        })
      });

      if (!response.ok) {
        throw new Error('Falha ao buscar matches. Verifique os dados e tente novamente.');
      }

      const data = await response.json();
      results = data;
    } catch (err: any) {
      errorMsg = err.message || 'Ocorreu um erro desconhecido.';
    } finally {
      loading = false;
    }
  }

  async function handleGenerateDossier() {
    if (!oscDetails) return;

    if (dossierResult) {
      await handleFetchMatches();
      return;
    }

    isDossierLoading = true;
    dossierError = null;
    dossierResult = null;

    try {
      const response = await fetch('/api/dossier', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cnpj: cnpj.replace(/[^\d]/g, ''),
          nome: oscDetails.nome_fantasia || oscDetails.razao_social,
          municipio: municipioState,
          uf: ufState
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Falha ao gerar dossiê.');
      }

      const data = await response.json();
      dossierResult = data.text;
      await handleFetchMatches();
    } catch (err: any) {
      dossierError = err.message || 'Ocorreu um erro ao gerar o dossiê.';
    } finally {
      isDossierLoading = false;
    }
  }

  async function handleDeepDive(editalId: string) {
    deepDiveLoading[editalId] = true;
    deepDiveErrors[editalId] = '';

    try {
      const response = await fetch('/api/deep-dive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          edital_id: editalId,
          oscProfile: {
            cnpj,
            nome: oscDetails?.nome_fantasia || oscDetails?.razao_social || '',
            municipio: municipioState,
            uf: ufState,
            natureza_juridica: naturezaJuridicaState,
            idade_anos: idadeAnosState,
            cnae_data: cnaeDataState,
            foco_atividades: focoAtividades
          },
          dossier_text: dossierResult
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Falha ao analisar edital em profundidade.');
      }

      const report = await response.json();
      report.used_dossier = !!dossierResult;
      deepDiveReports[editalId] = report;
    } catch (err: any) {
      deepDiveErrors[editalId] = err.message || 'Ocorreu um erro ao analisar o edital.';
    } finally {
      deepDiveLoading[editalId] = false;
    }
  }

  async function handleSearch(event: Event) {
    event.preventDefault();
    loading = true;
    errorMsg = null;
    oscDetails = null;
    results = null;
    dossierResult = null;

    try {
      const cleanCnpj = cnpj.replace(/[^\d]/g, '');

      if (cleanCnpj) {
        try {
          const brasilApiResponse = await fetch(`/api/cnpj/${cleanCnpj}`);
          if (brasilApiResponse.ok) {
            const cnpjData = await brasilApiResponse.json();

            oscDetails = {
              razao_social: cnpjData.razao_social,
              nome_fantasia: cnpjData.nome_fantasia,
              email: cnpjData.email,
              telefone: cnpjData.ddd_telefone_1,
              logradouro: cnpjData.logradouro,
              bairro: cnpjData.bairro,
              municipio: cnpjData.municipio,
              uf: cnpjData.uf,
            };

            ufState = cnpjData.uf || '';
            municipioState = cnpjData.municipio || '';
            naturezaJuridicaState = cnpjData.natureza_juridica || '';

            if (cnpjData.data_inicio_atividade) {
              const inicioAtividade = new Date(cnpjData.data_inicio_atividade);
              const hoje = new Date();
              let idade = hoje.getFullYear() - inicioAtividade.getFullYear();
              const m = hoje.getMonth() - inicioAtividade.getMonth();
              if (m < 0 || (m === 0 && hoje.getDate() < inicioAtividade.getDate())) {
                idade--;
              }
              idadeAnosState = idade;
            } else {
              idadeAnosState = 0;
            }

            let cnaeDesc = '';
            if (cnpjData.cnae_fiscal_descricao) {
              cnaeDesc += cnpjData.cnae_fiscal_descricao;
            }
            if (cnpjData.cnaes_secundarios && Array.isArray(cnpjData.cnaes_secundarios)) {
              for (const cnae of cnae.descricao ? cnpjData.cnaes_secundarios : cnpjData.cnaes_secundarios) {
                if (cnae.descricao) cnaeDesc += `, ${cnae.descricao}`;
              }
            }
            cnaeDataState = cnaeDesc;
          } else {
            const errorData = await brasilApiResponse.json().catch(() => ({}));
            throw new Error(errorData.message || `Falha ao buscar CNPJ (status ${brasilApiResponse.status}). Verifique o número e tente novamente.`);
          }
        } catch (err: any) {
          throw new Error(err.message || 'Erro de rede ao buscar dados do CNPJ.');
        }
      }
    } catch (err: any) {
      errorMsg = err.message || 'Ocorreu um erro desconhecido.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="min-h-screen bg-gray-50 text-gray-900 font-sans p-4 md:p-8">
  <div class="max-w-4xl mx-auto space-y-8">

    <!-- Search Section -->
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 md:p-8">
      <h1 class="text-2xl font-bold text-gray-900 mb-6">Encontrar Editais Compatíveis</h1>

      <form onsubmit={handleSearch} class="space-y-6">
        <div>
          <label for="cnpj" class="block text-sm font-medium text-gray-700 mb-1">CNPJ da OSC</label>
          <input
            type="text"
            id="cnpj"
            bind:value={cnpj}
            placeholder="00.000.000/0000-00"
            class="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors"
            required
          />
        </div>

        <div>
          <label for="foco" class="block text-sm font-medium text-gray-700 mb-1">Foco de Atividades</label>
          <p class="text-xs text-gray-500 mb-2">Descreva os principais temas, áreas de atuação e objetivos da sua organização (opcional).</p>
          <textarea
            id="foco"
            bind:value={focoAtividades}
            rows="4"
            placeholder="Ex: Trabalhamos com educação ambiental para jovens..."
            class="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors resize-y"
          ></textarea>
        </div>

        <button
          type="submit"
          disabled={loading}
          class="w-full md:w-auto inline-flex justify-center items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {#if loading && !oscDetails}
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Consultando dados do CNPJ...
          {:else}
            <svg class="mr-2 -ml-1 w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            Buscar Dados da Organização
          {/if}
        </button>
      </form>
    </section>

    <!-- Error Message -->
    {#if errorMsg}
      <div class="bg-red-50 border-l-4 border-red-400 p-4 rounded-md">
        <div class="flex">
          <div class="flex-shrink-0">
            <svg class="h-5 w-5 text-red-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
            </svg>
          </div>
          <div class="ml-3">
            <p class="text-sm text-red-700">{errorMsg}</p>
          </div>
        </div>
      </div>
    {/if}

    <!-- OSC Details Profile Section -->
    {#if oscDetails}
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 md:p-8">
        <div class="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-6">
          <div>
            <h2 class="text-xl font-bold text-gray-900 mb-2">Perfil da Organização</h2>
            <h3 class="text-lg font-semibold text-gray-800">{oscDetails.nome_fantasia || oscDetails.razao_social}</h3>
            <p class="text-sm text-gray-600">{oscDetails.razao_social}</p>
          </div>
          <div class="flex flex-col sm:flex-row gap-3 mt-4 md:mt-0">
            <button
              onclick={handleFetchMatches}
              disabled={isDossierLoading || loading}
              class="shrink-0 inline-flex justify-center items-center px-4 py-2 border border-blue-200 shadow-sm text-sm font-medium rounded-md text-blue-700 bg-blue-50 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
            >
              {#if loading && !isDossierLoading}
                <svg class="animate-spin mr-2 -ml-1 h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Buscando Editais...
              {:else}
                <span class="mr-2">⚡</span>
                Buscar Editais (Sem Dossiê)
              {/if}
            </button>

            <button
              onclick={handleGenerateDossier}
              disabled={isDossierLoading || loading}
              class="shrink-0 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 transition-colors"
            >
              {#if isDossierLoading}
                <svg class="animate-spin mr-2 -ml-1 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Gerando Dossiê e Buscando Editais...
              {:else if dossierResult}
                <span class="mr-2">🔄</span>
                Atualizar Matches com Dossiê
              {:else}
                <span class="mr-2">✨</span>
                Gerar Dossiê de IA & Buscar Editais
              {/if}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-700 mb-6">
          <div>
            <span class="font-semibold">Email:</span> {#if oscDetails.email}<a href="mailto:{oscDetails.email}" class="text-blue-600 hover:underline">{oscDetails.email}</a>{:else}Não informado{/if}
          </div>
          <div>
            <span class="font-semibold">Telefone:</span> {#if oscDetails.telefone}{oscDetails.telefone}{:else}Não informado{/if}
          </div>
          <div>
            <span class="font-semibold">Idade do CNPJ:</span> {idadeAnosState} anos ({naturezaJuridicaState})
          </div>
          <div>
            <span class="font-semibold">Localização:</span> {oscDetails.municipio} - {oscDetails.uf}
          </div>
          <div class="md:col-span-2">
            <span class="font-semibold">CNAE Registrado:</span> {cnaeDataState || 'Não informado'}
          </div>
        </div>

        {#if dossierError}
          <div class="mt-4 text-sm text-red-600 bg-red-50 p-3 rounded border border-red-100">
            {dossierError}
          </div>
        {/if}

        {#if dossierResult}
          <div class="mt-6 border-t border-gray-200 pt-6">
            <h4 class="text-lg font-bold text-gray-900 mb-4">Dossiê da Organização</h4>
            <div class="prose prose-sm max-w-none text-gray-700 prose-headings:text-gray-900 prose-a:text-blue-600">
              {@html marked.parse(dossierResult)}
            </div>
          </div>
        {/if}
      </section>
    {/if}

    <!-- Results Section -->
    {#if results}
      <section class="space-y-4">
        {#if results.length > 0 && !dossierResult}
          <div class="bg-blue-50 border-l-4 border-blue-500 p-4 mb-6">
            <p class="text-sm text-blue-700">💡 <strong>Dica:</strong> Gere o Dossiê da Organização acima para que a Análise em Profundidade sugira projetos altamente personalizados baseados na atuação real da OSC na web.</p>
          </div>
        {/if}
        <h2 class="text-xl font-bold text-gray-900 mb-4">Top Matches ({results.length})</h2>

        {#if results.length === 0}
          <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center text-gray-500">
            <p>Nenhum edital compatível encontrado para o perfil informado.</p>
          </div>
        {:else}
          <div class="grid grid-cols-1 gap-4">
            {#each results as match}
              <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
                <div class="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4">
                  <div class="flex-1">
                    <h3 class="text-lg font-semibold text-gray-900 leading-snug mb-2">{match.titulo}</h3>

                    <div class="inline-flex flex-wrap gap-2 mb-3">
                      <div class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-50 text-blue-700 border border-blue-100">
                        Match Score: {match.score}%
                      </div>

                      <div class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-50 text-green-700 border border-green-100">
                        Valor Máximo: {match.valor_maximo_reais ? match.valor_maximo_reais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Não informado'}
                      </div>

                      {#if match.prazo_de_inscricao && match.prazo_de_inscricao !== 'Não informado'}
                        <div class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-50 text-yellow-700 border border-yellow-100">
                          Prazo: {new Date(match.prazo_de_inscricao).toLocaleDateString('pt-BR')}
                        </div>
                      {:else}
                        <div class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-50 text-gray-700 border border-gray-200">
                          Fluxo Contínuo / Consulte o Edital
                        </div>
                      {/if}
                    </div>
                  </div>

                  <div class="flex items-center gap-2">
                    {#if match.deep_metadata?.drive_link || match.pdf_url}
                      <a
                        href={match.deep_metadata?.drive_link || match.pdf_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="shrink-0 inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                      >
                        <span class="mr-2 text-lg">📄</span>
                        Ver Edital
                      </a>
                    {/if}
                    {#if oscDetails?.telefone}
                      <a
                        href="https://wa.me/55{oscDetails.telefone.replace(/[^\d]/g, '')}?text=Olá,%20equipe%20da%20*{oscDetails.nome_fantasia || oscDetails.razao_social}*!%20Nosso%20sistema%20mapeou%20um%20edital%20perfeito%20para%20vocês:%20_{match.titulo}_.%20Teriam%205%20minutinhos%20para%20eu%20apresentar%20essa%20oportunidade?"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="shrink-0 inline-flex items-center px-4 py-2 border border-green-300 shadow-sm text-sm font-medium rounded-md text-green-700 bg-green-50 hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
                      >
                        <span class="mr-2 text-lg">💬</span>
                        WhatsApp
                      </a>
                    {/if}
                    <button
                      onclick={() => handleDeepDive(match.edital_id)}
                      disabled={deepDiveLoading[match.edital_id]}
                      class="shrink-0 inline-flex items-center px-4 py-2 border shadow-sm text-sm font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 transition-colors {dossierResult ? 'border-purple-300 text-purple-700 bg-purple-50 hover:bg-purple-100 focus:ring-purple-500' : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50 focus:ring-blue-500'}"
                    >
                      {#if deepDiveLoading[match.edital_id]}
                        <svg class="animate-spin mr-2 -ml-1 h-4 w-4 {dossierResult ? 'text-purple-500' : 'text-gray-500'}" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Reading PDF...
                      {:else}
                        {#if dossierResult}
                          <span class="mr-2">✨</span>
                          Analisar com Dossiê
                        {:else}
                          <svg class="mr-2 -ml-1 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                          Analisar em Profundidade
                        {/if}
                      {/if}
                    </button>
                  </div>
                </div>

                <div class="bg-gray-50 rounded-lg p-4 border border-gray-100 mb-4">
                  <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Por que este edital?</h4>
                  <p class="text-sm text-gray-700 italic">"{match.motivo_match}"</p>
                </div>

                {#if deepDiveErrors[match.edital_id]}
                  <div class="mt-4 text-sm text-red-600 bg-red-50 p-3 rounded border border-red-100">
                    {deepDiveErrors[match.edital_id]}
                  </div>
                {/if}

                {#if deepDiveReports[match.edital_id]}
                  <div class="mt-6 border-t border-gray-200 pt-6">
                    <div class="flex items-center justify-between mb-4">
                      <h4 class="text-lg font-bold text-gray-900">Deep Dive Consulting Report</h4>
                      {#if deepDiveReports[match.edital_id].used_dossier}
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 border border-purple-200">
                          Contexto: Dados Oficiais + Web Dossiê Avançado
                        </span>
                      {:else}
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 border border-gray-200">
                          Contexto: Dados Oficiais Básicos
                        </span>
                      {/if}
                    </div>

                    <div class="space-y-6">
                      <!-- Executive Summary -->
                      {#if deepDiveReports[match.edital_id].executive_summary}
                        <div class="bg-gray-50 rounded-lg p-5 border-l-4 border-gray-400 shadow-sm mb-6">
                          <h5 class="text-sm font-bold text-gray-700 uppercase tracking-wider mb-2">Resumo Executivo</h5>
                          <p class="text-gray-800 text-sm italic leading-relaxed">
                            {deepDiveReports[match.edital_id].executive_summary}
                          </p>
                        </div>
                      {/if}

                      <!-- Missing Documents -->
                      <div>
                        <h5 class="text-sm font-semibold text-gray-800 flex items-center mb-2">
                          <span class="text-xl mr-2">📄</span> Documentos Faltantes/Requeridos
                        </h5>
                        <ul class="list-disc pl-8 space-y-1 text-sm text-gray-700">
                          {#each deepDiveReports[match.edital_id].missing_documents as doc}
                            <li>{doc}</li>
                          {/each}
                        </ul>
                      </div>

                      <!-- Statute Requirements -->
                      <div>
                        <h5 class="text-sm font-semibold text-gray-800 flex items-center mb-2">
                          <span class="text-xl mr-2">⚖️</span> Requisitos Estatutários
                        </h5>
                        <ul class="list-disc pl-8 space-y-1 text-sm text-gray-700">
                          {#each deepDiveReports[match.edital_id].statute_requirements as req}
                            <li>{req}</li>
                          {/each}
                        </ul>
                      </div>

                      <!-- Project Ideas -->
                      <div>
                        <h5 class="text-sm font-semibold text-gray-800 flex items-center mb-3">
                          <span class="text-xl mr-2">💡</span> Ideias de Projetos Customizadas
                        </h5>
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {#each deepDiveReports[match.edital_id].project_ideas as idea}
                            <div class="bg-blue-50 rounded-lg p-4 border border-blue-100">
                              <h6 class="font-bold text-blue-900 text-sm mb-2">{idea.title}</h6>
                              <p class="text-sm text-blue-800">{idea.description}</p>
                            </div>
                          {/each}
                        </div>
                      </div>
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

  </div>
</div>
