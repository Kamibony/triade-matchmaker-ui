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

  function getWhatsAppLink(lead: any, message: string) {
    let phone = lead.contatos_encontrados?.whatsapp || lead.osc?.official_contacts?.ddd_telefone_1 || lead.osc?.official_contacts?.ddd_telefone_2;
    if (!phone) return '#';
    const cleanPhone = phone.toString().replace(/\D/g, '');
    return `https://wa.me/55${cleanPhone}?text=${encodeURIComponent(message)}`;
  }
</script>

<div class="flex h-screen bg-gray-50 font-sans">
  <!-- Left Pane: Editais List -->
  <div class="w-1/3 bg-white border-r border-gray-200 flex flex-col">
    <div class="p-6 border-b border-gray-200">
      <h1 class="text-2xl font-bold text-gray-900">Radar de Captação</h1>
      <p class="text-sm text-gray-500 mt-1">Selecione um edital para ver as OSCs compatíveis.</p>
    </div>

    <div class="flex-1 overflow-y-auto">
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
    </div>
  </div>

  <!-- Right Pane: Leads Feed -->
  <div class="w-2/3 flex flex-col h-full">
    {#if selectedEditalId && groupedLeads[selectedEditalId]}
      <div class="p-6 bg-white border-b border-gray-200 shadow-sm z-10">
        <h2 class="text-xl font-semibold text-gray-800">
          Matches para: <span class="text-indigo-600">{groupedLeads[selectedEditalId].titulo}</span>
        </h2>
      </div>

      <div class="flex-1 overflow-y-auto p-6 space-y-6 bg-gray-100">
        {#each groupedLeads[selectedEditalId].leads as lead, index}
          <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <!-- Header -->
            <div class="p-6 border-b border-gray-100 flex justify-between items-start">
              <div>
                <h3 class="text-lg font-bold text-gray-900">{lead.osc.nome}</h3>
                <p class="text-sm text-gray-500 mt-1">📍 {lead.osc.municipio}, {lead.osc.uf}</p>
                <p class="text-xs text-gray-400 mt-1">CNPJ: {lead.osc.cnpj}</p>
              </div>
              <div class="flex flex-col items-end">
                <span class="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold {getScoreColor(lead.score)}">
                  Score: {lead.score}
                </span>
              </div>
            </div>

            <!-- Body -->
            <div class="p-6 space-y-4">
              <!-- Motivo -->
              <div>
                <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Por que é um bom match?</h4>
                <p class="text-gray-700 text-sm">{lead.motivo_match}</p>
              </div>

              <!-- Contatos -->
              <div class="bg-gray-50 p-4 rounded-lg border border-gray-100">
                <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Contatos</h4>
                <div class="grid grid-cols-2 gap-4 text-sm">
                  {#if lead.contatos_encontrados?.whatsapp}
                    <div class="flex items-center text-green-700 font-medium">
                      <span class="mr-2">📱</span> WhatsApp: {lead.contatos_encontrados.whatsapp}
                    </div>
                  {:else if lead.osc?.official_contacts?.ddd_telefone_1}
                    <div class="flex items-center text-gray-500">
                      <span class="mr-2">📱</span> Oficial: {lead.osc.official_contacts.ddd_telefone_1}
                    </div>
                  {/if}

                  {#if lead.contatos_encontrados?.email}
                    <div class="flex items-center text-blue-700">
                      <span class="mr-2">📧</span> {lead.contatos_encontrados.email}
                    </div>
                  {:else if lead.osc?.official_contacts?.email}
                     <div class="flex items-center text-gray-500">
                      <span class="mr-2">📧</span> Oficial: {lead.osc.official_contacts.email}
                    </div>
                  {/if}

                  {#if lead.contatos_encontrados?.instagram}
                    <div class="flex items-center text-pink-600 col-span-2">
                      <span class="mr-2">📸</span> <a href="{lead.contatos_encontrados.instagram}" target="_blank" class="hover:underline">{lead.contatos_encontrados.instagram}</a>
                    </div>
                  {/if}
                </div>
              </div>

              <!-- Message Area -->
              <div>
                 <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Mensagem Sugerida</h4>
                 <textarea
                   class="w-full text-sm text-gray-700 p-3 border border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 shadow-sm"
                   rows="4"
                   bind:value={lead.whatsapp_message}
                 ></textarea>
              </div>

              <!-- Actions -->
              <div class="flex justify-between items-center pt-4">
                <button
                  class="text-sm font-medium text-indigo-600 hover:text-indigo-800 focus:outline-none"
                  onclick={() => toggleDossier(index)}
                >
                  {openDossierIndex === index ? '▲ Ocultar Dossiê' : '▼ Ver Dossiê Completo'}
                </button>

                <div class="flex space-x-3">
                  <!-- Descartar (No-op visually for now, or just hide) -->
                  <button class="px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
                    Descartar
                  </button>
                  <a
                    href={getWhatsAppLink(lead, lead.whatsapp_message)}
                    target="_blank"
                    class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                  >
                    <span class="mr-2">💬</span>
                    Enviar WhatsApp
                  </a>
                </div>
              </div>

              <!-- Deep Dive Dossier -->
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
  </div>
</div>
