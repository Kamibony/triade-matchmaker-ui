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

  async function handleGenerateDossier() {
    if (!oscDetails) return;

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
          nome: oscDetails.nome_fantasia || oscDetails.razao_social
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Falha ao gerar dossiê.');
      }

      const data = await response.json();
      dossierResult = data.text;
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
            foco_atividades: focoAtividades
          }
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Falha ao analisar edital em profundidade.');
      }

      const report = await response.json();
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
    results = null;

    try {
      const cleanCnpj = cnpj.replace(/[^\d]/g, '');
      let uf = '';
      let municipio = '';
      let natureza_juridica = '';
      let idade_anos = 0;
      let cnae_data = '';

      if (cleanCnpj) {
        try {
          const brasilApiResponse = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cleanCnpj}`);
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

            uf = cnpjData.uf || '';
            municipio = cnpjData.municipio || '';
            natureza_juridica = cnpjData.natureza_juridica || '';

            if (cnpjData.data_inicio_atividade) {
              const inicioAtividade = new Date(cnpjData.data_inicio_atividade);
              const hoje = new Date();
              let idade = hoje.getFullYear() - inicioAtividade.getFullYear();
              const m = hoje.getMonth() - inicioAtividade.getMonth();
              if (m < 0 || (m === 0 && hoje.getDate() < inicioAtividade.getDate())) {
                idade--;
              }
              idade_anos = idade;
            }

            let cnaeDesc = '';
            if (cnpjData.cnae_fiscal_descricao) {
              cnaeDesc += cnpjData.cnae_fiscal_descricao;
            }
            if (cnpjData.cnaes_secundarios && Array.isArray(cnpjData.cnaes_secundarios)) {
              for (const cnae of cnpjData.cnaes_secundarios) {
                if (cnae.descricao) cnaeDesc += `, ${cnae.descricao}`;
              }
            }
            cnae_data = cnaeDesc;
          } else {
            console.error(`BrasilAPI request failed with status: ${brasilApiResponse.status}`);
          }
        } catch (err) {
          console.error('Error fetching CNPJ data from BrasilAPI:', err);
        }
      }

      const response = await fetch('/api/match', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cnpj,
          foco_atividades: focoAtividades,
          cnae_data,
          uf,
          municipio,
          natureza_juridica,
          idade_anos
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
          <p class="text-xs text-gray-500 mb-2">Descreva os principais temas, áreas de atuação e objetivos da sua organização.</p>
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
          {#if loading}
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Analisando dezenas de editais...
          {:else}
            <svg class="mr-2 -ml-1 w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            Pesquisar Editais
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
          <button
            onclick={handleGenerateDossier}
            disabled={isDossierLoading}
            class="shrink-0 inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 transition-colors"
          >
            {#if isDossierLoading}
              <svg class="animate-spin mr-2 -ml-1 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Gerando Dossiê...
            {:else}
              <span class="mr-2">✨</span>
              Gerar Dossiê de IA (Busca na Web)
            {/if}
          </button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-700 mb-6">
          <div>
            <span class="font-semibold">Email:</span> {oscDetails.email || 'Não informado'}
          </div>
          <div>
            <span class="font-semibold">Telefone:</span> {oscDetails.telefone || 'Não informado'}
          </div>
          <div class="md:col-span-2">
            <span class="font-semibold">Endereço:</span> {oscDetails.logradouro}, {oscDetails.bairro}, {oscDetails.municipio} - {oscDetails.uf}
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

                    <div class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-50 text-blue-700 mb-3 border border-blue-100">
                      Match Score: {match.score}%
                    </div>
                  </div>

                  <div class="flex items-center gap-2">
                    {#if match.pdf_url}
                      <a
                        href={match.pdf_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="shrink-0 inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                      >
                        <span class="mr-2 text-lg">📄</span>
                        Ver Edital
                      </a>
                    {/if}
                    <button
                      onclick={() => handleDeepDive(match.edital_id)}
                      disabled={deepDiveLoading[match.edital_id]}
                      class="shrink-0 inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
                    >
                      {#if deepDiveLoading[match.edital_id]}
                        <svg class="animate-spin mr-2 -ml-1 h-4 w-4 text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Reading PDF...
                      {:else}
                        <svg class="mr-2 -ml-1 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                        Analisar em Profundidade
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
                    <h4 class="text-lg font-bold text-gray-900 mb-4">Deep Dive Consulting Report</h4>

                    <div class="space-y-6">
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
