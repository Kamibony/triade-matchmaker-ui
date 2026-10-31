<script lang="ts">
  let cnpj = $state('');
  let focoAtividades = $state('');
  let loading = $state(false);
  let results = $state<any[] | null>(null);
  let errorMsg = $state<string | null>(null);

  async function handleSearch(event: Event) {
    event.preventDefault();
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
          foco_atividades: focoAtividades
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
            required
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

                  <button class="shrink-0 inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors">
                    <svg class="mr-2 -ml-1 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                    Analyze in Depth
                  </button>
                </div>

                <div class="bg-gray-50 rounded-lg p-4 border border-gray-100">
                  <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Por que este edital?</h4>
                  <p class="text-sm text-gray-700 italic">"{match.motivo_match}"</p>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

  </div>
</div>
