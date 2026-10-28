<script lang="ts">
  import oscsData from './data/oscs-matchmaking.json';

  let selectedNgoIndex = $state(0);
  let selectedNgo = $derived(oscsData[selectedNgoIndex]);
</script>

<div class="flex h-screen bg-gray-50 text-gray-900">
  <!-- Sidebar -->
  <aside class="w-64 bg-white border-r border-gray-200 hidden md:block overflow-y-auto">
    <div class="p-6">
      <h1 class="text-xl font-bold text-gray-800">OSCs</h1>
      <p class="text-sm text-gray-500 mt-2">Lista de organizações</p>
    </div>
    <nav class="mt-6">
      <ul class="space-y-2 px-4 pb-6">
        {#each oscsData as ngo, i}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            class="p-2 rounded-md cursor-pointer {selectedNgoIndex === i ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-gray-100 text-gray-700'}"
            onclick={() => selectedNgoIndex = i}
          >
            {ngo.nome}
          </li>
        {/each}
      </ul>
    </nav>
  </aside>

  <!-- Main Content Area -->
  <main class="flex-1 overflow-y-auto p-8">
    {#if selectedNgo}
      <header class="mb-8">
        <h2 class="text-2xl font-bold text-gray-800">{selectedNgo.nome}</h2>
        <p class="text-gray-600 mt-2">{selectedNgo.foco}</p>
      </header>

      <div class="mb-6">
        <h3 class="text-xl font-semibold text-gray-800">Editais Compatíveis</h3>
      </div>

      {#if selectedNgo.matches.length === 0}
        <div class="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <p class="text-gray-500 text-lg">Nenhum edital compatível no momento</p>
        </div>
      {:else}
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {#each selectedNgo.matches as match}
            <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow flex flex-col">
              <div class="mb-4 flex-grow">
                <h3 class="text-lg font-semibold text-gray-900 mb-2">{match.edital}</h3>
                <div class="flex flex-wrap gap-2 mb-3">
                  <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                    Data Limite: {match.expiracao}
                  </span>
                  <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    Pontuação: {match.score}
                  </span>
                </div>
              </div>
              <div class="mt-4 pt-4 border-t border-gray-100">
                <a
                  href={match.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex w-full justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  🔗 Acessar Edital
                </a>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </main>
</div>
