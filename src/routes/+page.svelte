<script lang="ts">
  import EditalCard from '../lib/components/EditalCard.svelte';
  import oscsData from '../data/oscs-matchmaking.json';
  import editaisData from '../data/editais_prosas.json';
  import { calculateMatches } from '../lib/matcher';

  let availableEditais = $derived(editaisData.filter((edital: any) => edital.deep_metadata));
  let selectedEditalIndex = $state(0);
  let selectedEdital = $derived(availableEditais[selectedEditalIndex]);
  let matchResults = $state<any[] | null>(null);

  $effect(() => {
    // Reset match results when selected edital changes
    const _ = selectedEditalIndex;
    matchResults = null;
  });

  function formatCurrency(value: number | null | undefined) {
    if (value === undefined || value === null) return 'Não especificado';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  }

  function handleVerificarMatches() {
    matchResults = calculateMatches(selectedEdital.deep_metadata, oscsData);
  }
</script>

<div class="flex h-screen bg-gray-50 text-gray-900 overflow-hidden font-sans">

  <!-- Left Column: Opportunities -->
  <aside class="w-full md:w-1/3 lg:w-1/4 xl:w-1/3 bg-white border-r border-gray-200 flex flex-col h-full z-10 shadow-sm relative">
    <div class="p-6 border-b border-gray-200 bg-white sticky top-0 z-20">
      <h1 class="text-2xl font-black text-gray-900 tracking-tight">Oportunidades</h1>
      <p class="text-sm text-gray-500 mt-1">Selecione um edital para ver detalhes</p>
    </div>

    <div class="flex-1 overflow-y-auto p-4 bg-gray-50/50">
      <div class="space-y-4">
        {#each availableEditais as edital, i}
          <EditalCard
            {edital}
            selected={selectedEditalIndex === i}
            onSelect={() => selectedEditalIndex = i}
          />
        {/each}
      </div>
    </div>
  </aside>

  <!-- Right Column: Matchmaker Details -->
  <main class="flex-1 flex flex-col h-full bg-gray-50 overflow-y-auto">
    {#if selectedEdital}
      <!-- Header Area -->
      <div class="bg-white border-b border-gray-200 p-8">
        <div class="max-w-4xl mx-auto">
          <div class="flex justify-between items-start mb-4">
            <h2 class="text-3xl font-bold text-gray-900 leading-tight pr-8">{selectedEdital.attributes.nome}</h2>
            <a href={selectedEdital.public_url} target="_blank" rel="noopener noreferrer" class="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 shrink-0">
              Ver Original
              <svg class="ml-2 -mr-1 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
            </a>
          </div>

          <p class="text-lg text-gray-600 mb-6">{selectedEdital.deep_metadata?.resumo_objetivo}</p>

          <div class="flex flex-wrap gap-4 pt-4 border-t border-gray-100">
            <div class="bg-blue-50 px-4 py-3 rounded-lg flex-1 min-w-[200px] border border-blue-100">
              <span class="block text-sm font-medium text-blue-800 mb-1">Valor Máximo</span>
              <span class="block text-xl font-bold text-blue-900">{formatCurrency(selectedEdital.deep_metadata?.financeiro?.valor_maximo_reais)}</span>
            </div>

            <div class="bg-orange-50 px-4 py-3 rounded-lg flex-1 min-w-[200px] border border-orange-100">
              <span class="block text-sm font-medium text-orange-800 mb-1">Inscrições até</span>
              <span class="block text-xl font-bold text-orange-900">{(selectedEdital.attributes as any).inscricoes_ate || 'Não especificado'}</span>
            </div>

            <div class="bg-purple-50 px-4 py-3 rounded-lg flex-1 min-w-[200px] border border-purple-100">
              <span class="block text-sm font-medium text-purple-800 mb-1">Âmbito</span>
              <span class="block text-xl font-bold text-purple-900">
                {selectedEdital.deep_metadata?.criterios_eliminatorios?.abrangencia_nacional ? 'Nacional' : 'Regional'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Matchmaker Area -->
      <div class="p-8 flex-1 max-w-4xl mx-auto w-full">

        <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden mb-8">
          <div class="p-6 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
            <div>
              <h3 class="text-xl font-bold text-gray-900">Análise de Match</h3>
              <p class="text-sm text-gray-500 mt-1">Verifique quais OSCs são compatíveis com os critérios deste edital.</p>
            </div>
            <button
              onclick={handleVerificarMatches}
              class="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
            >
              <svg class="mr-2 -ml-1 w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
              Verificar Matches
            </button>
          </div>

          <div class="p-6">
            <h4 class="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">OSCs Cadastradas ({oscsData.length})</h4>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              {#if matchResults}
                {#each matchResults as osc}
                  <div class="border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors bg-white">
                    <div class="flex items-start justify-between">
                      <h5 class="font-semibold text-gray-900 mb-1 {osc.eligibility.isEligible ? '' : 'text-gray-400 line-through'}">{osc.nome}</h5>
                      <span class="ml-2 flex-shrink-0">
                        {#if !osc.eligibility.isEligible}
                          <span title={osc.eligibility.failedReason}>❌</span>
                        {:else if osc.eligibility.score > 0}
                          <span class="bg-green-100 text-green-800 text-xs font-medium me-2 px-2.5 py-0.5 rounded" title="Strong Match: Score {osc.eligibility.score}">✅</span>
                        {:else}
                          <span title="Eligible but no theme match">⚠️</span>
                        {/if}
                      </span>
                    </div>
                    {#if !osc.eligibility.isEligible}
                      <p class="text-xs text-red-500 mt-1 mb-2">{osc.eligibility.failedReason}</p>
                    {/if}
                    <p class="text-xs text-gray-500 line-clamp-2">{osc.foco}</p>
                  </div>
                {/each}
              {:else}
                {#each oscsData.slice(0, 6) as osc}
                  <div class="border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors bg-white">
                    <h5 class="font-semibold text-gray-900 mb-1">{osc.nome}</h5>
                    <p class="text-xs text-gray-500 line-clamp-2">{osc.foco}</p>
                  </div>
                {/each}
                {#if oscsData.length > 6}
                  <div class="border border-dashed border-gray-300 rounded-lg p-4 flex items-center justify-center bg-gray-50 text-gray-500">
                    + {oscsData.length - 6} outras organizações
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        </div>

        <!-- Deep Metadata Debug View (Optional for development) -->
        <details class="bg-gray-800 rounded-lg overflow-hidden group">
          <summary class="p-4 cursor-pointer text-gray-300 font-mono text-sm font-semibold flex items-center bg-gray-900 group-open:border-b border-gray-700">
            <svg class="w-4 h-4 mr-2 transform group-open:rotate-90 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
            DEBUG: deep_metadata JSON
          </summary>
          <pre class="p-4 text-xs text-green-400 overflow-x-auto">
            {JSON.stringify(selectedEdital.deep_metadata, null, 2)}
          </pre>
        </details>
      </div>

    {:else}
      <div class="flex-1 flex items-center justify-center text-gray-500 p-8 h-full">
        <div class="text-center">
          <svg class="mx-auto h-12 w-12 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
          <p class="text-lg">Selecione um edital na lista para ver os detalhes e matches.</p>
        </div>
      </div>
    {/if}
  </main>
</div>
