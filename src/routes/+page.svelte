<script lang="ts">
  let cnpj = $state('');
  let uf = $state('');
  let city = $state('');
  let age = $state('');
  let legal_nature = $state('');
  let foco_atividades = $state('');

  let loading = $state(false);
  let results = $state<any[] | null>(null);
  let error = $state<string | null>(null);

  async function handleSearch(event: Event) {
    event.preventDefault();
    loading = true;
    error = null;
    results = null;

    const oscProfile = {
      cnpj,
      uf,
      city,
      age: age ? parseInt(age, 10) : undefined,
      legal_nature,
      foco_atividades
    };

    try {
      const response = await fetch('/api/match', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(oscProfile)
      });

      if (!response.ok) {
        throw new Error('Falha ao buscar os dados.');
      }

      results = await response.json();
    } catch (err: any) {
      error = err.message || 'Ocorreu um erro desconhecido.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 font-sans">
  <div class="max-w-5xl mx-auto space-y-8">
    <div class="text-center">
      <h1 class="text-4xl font-extrabold text-gray-900 tracking-tight sm:text-5xl">
        Motor de Busca <span class="text-blue-600">Zero-Billing</span>
      </h1>
      <p class="mt-4 text-xl text-gray-500">
        Encontre os melhores editais para a sua OSC usando Inteligência Artificial.
      </p>
    </div>

    <div class="bg-white shadow-xl rounded-2xl overflow-hidden border border-gray-100">
      <div class="px-6 py-8 sm:p-10">
        <form onsubmit={handleSearch} class="space-y-6">
          <div class="grid grid-cols-1 gap-y-6 gap-x-4 sm:grid-cols-2">
            <div>
              <label for="cnpj" class="block text-sm font-medium text-gray-700">CNPJ</label>
              <div class="mt-1">
                <input type="text" id="cnpj" bind:value={cnpj} required class="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md border p-2" placeholder="Ex: 00.000.000/0000-00">
              </div>
            </div>

            <div>
              <label for="age" class="block text-sm font-medium text-gray-700">Idade da OSC (anos)</label>
              <div class="mt-1">
                <input type="number" id="age" bind:value={age} required class="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md border p-2" placeholder="Ex: 5">
              </div>
            </div>

            <div>
              <label for="uf" class="block text-sm font-medium text-gray-700">Estado (UF)</label>
              <div class="mt-1">
                <input type="text" id="uf" bind:value={uf} required class="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md border p-2" placeholder="Ex: SP">
              </div>
            </div>

            <div>
              <label for="city" class="block text-sm font-medium text-gray-700">Cidade</label>
              <div class="mt-1">
                <input type="text" id="city" bind:value={city} required class="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md border p-2" placeholder="Ex: São Paulo">
              </div>
            </div>

            <div class="sm:col-span-2">
              <label for="legal_nature" class="block text-sm font-medium text-gray-700">Natureza Jurídica</label>
              <div class="mt-1">
                <input type="text" id="legal_nature" bind:value={legal_nature} required class="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border-gray-300 rounded-md border p-2" placeholder="Ex: Associação Privada">
              </div>
            </div>

            <div class="sm:col-span-2">
              <label for="foco_atividades" class="block text-sm font-medium text-gray-700">Foco e Atividades Principais</label>
              <div class="mt-1">
                <textarea id="foco_atividades" bind:value={foco_atividades} rows="4" required class="shadow-sm focus:ring-blue-500 focus:border-blue-500 block w-full sm:text-sm border border-gray-300 rounded-md p-2" placeholder="Descreva as principais áreas de atuação, projetos e público-alvo da sua organização..."></textarea>
              </div>
            </div>
          </div>

          <div class="flex justify-end pt-4">
            <button type="submit" disabled={loading} class="inline-flex justify-center py-3 px-6 border border-transparent shadow-sm text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200">
              {#if loading}
                <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Analysing grants...
              {:else}
                Buscar Editais Compatíveis
              {/if}
            </button>
          </div>
        </form>
      </div>
    </div>

    {#if error}
      <div class="rounded-md bg-red-50 p-4 border border-red-200">
        <div class="flex">
          <div class="flex-shrink-0">
            <svg class="h-5 w-5 text-red-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
            </svg>
          </div>
          <div class="ml-3">
            <h3 class="text-sm font-medium text-red-800">Erro ao realizar a busca</h3>
            <div class="mt-2 text-sm text-red-700">
              <p>{error}</p>
            </div>
          </div>
        </div>
      </div>
    {/if}

    {#if loading}
      <div class="text-center py-12">
         <div class="inline-block animate-bounce text-blue-600 mb-4">
            <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
         </div>
         <h3 class="mt-2 text-lg font-medium text-gray-900">Analisando centenas de editais...</h3>
         <p class="mt-1 text-gray-500">Nossa Inteligência Artificial está buscando as melhores oportunidades para o seu perfil.</p>
      </div>
    {:else if results && results.length > 0}
      <div class="space-y-6 mt-10">
        <h2 class="text-2xl font-bold text-gray-900 border-b pb-4">Top {results.length} Editais Compatíveis</h2>
        <div class="grid gap-6">
          {#each results as match}
            <div class="bg-white rounded-xl shadow-md border border-gray-200 overflow-hidden hover:shadow-lg transition-shadow duration-300">
              <div class="p-6 sm:p-8">
                <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div class="flex-1">
                    <h3 class="text-xl font-bold text-gray-900 mb-2">{match.titulo}</h3>
                    <div class="mt-4 bg-gray-50 rounded-lg p-4 border border-gray-100">
                      <h4 class="text-sm font-semibold text-gray-700 mb-1 flex items-center">
                        <svg class="w-4 h-4 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                        Justificativa da IA
                      </h4>
                      <p class="text-sm text-gray-600 italic">"{match.motivo_match}"</p>
                    </div>
                  </div>
                  <div class="flex flex-col items-center sm:items-end shrink-0">
                    <div class="flex items-center justify-center w-20 h-20 rounded-full border-4 {match.score >= 80 ? 'border-green-500' : match.score >= 60 ? 'border-yellow-500' : 'border-orange-500'} bg-gray-50 mb-3">
                      <span class="text-2xl font-black text-gray-900">{match.score}</span>
                    </div>
                    <span class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-4">Score de Match</span>

                    <button class="w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors">
                      <svg class="w-4 h-4 mr-2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                      Análise Profunda
                    </button>
                  </div>
                </div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {:else if results && results.length === 0}
      <div class="text-center py-12 bg-white rounded-xl border border-gray-200 mt-8">
        <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
        <h3 class="mt-2 text-lg font-medium text-gray-900">Nenhum edital encontrado</h3>
        <p class="mt-1 text-gray-500">Não encontramos nenhum edital altamente compatível com o perfil da sua OSC no momento.</p>
      </div>
    {/if}
  </div>
</div>
