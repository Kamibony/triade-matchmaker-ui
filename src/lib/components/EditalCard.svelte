<script lang="ts">
  type EditalProps = {
    edital: any;
    selected: boolean;
    onSelect: () => void;
  };

  let { edital, selected, onSelect }: EditalProps = $props();

  function formatCurrency(value: number | undefined) {
    if (value === undefined || value === null) return 'Não especificado';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  }
</script>

<button
  class="w-full text-left p-4 mb-4 rounded-xl border transition-all duration-200 {selected ? 'border-blue-500 bg-blue-50/50 shadow-md ring-1 ring-blue-500' : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm'}"
  onclick={onSelect}
>
  <div class="flex justify-between items-start mb-2">
    <h3 class="text-lg font-bold text-gray-900 leading-tight line-clamp-2 pr-4">{edital.attributes?.nome || 'Edital sem nome'}</h3>
    <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 shrink-0">
      {edital.attributes?.e_central_label || 'Central'}
    </span>
  </div>

  <p class="text-sm text-gray-600 mb-3 line-clamp-2">{edital.deep_metadata?.resumo_objetivo || 'Sem resumo'}</p>

  <div class="flex flex-wrap gap-2 mb-4">
    {#if edital.deep_metadata?.temas_principais}
      {#each edital.deep_metadata.temas_principais as tema}
        <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
          {tema}
        </span>
      {/each}
    {/if}
  </div>

  <div class="pt-3 border-t border-gray-100 flex flex-wrap justify-between items-center text-sm">
    <div class="flex items-center text-green-700 font-semibold">
      <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
      {formatCurrency(edital.deep_metadata?.financeiro?.valor_maximo_reais)}
    </div>

    {#if edital.attributes?.inscricoes_ate}
      <div class="flex items-center text-gray-500">
        <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
        {edital.attributes.inscricoes_ate}
      </div>
    {/if}
  </div>
</button>
