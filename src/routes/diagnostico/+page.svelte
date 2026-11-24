<script lang="ts">
  import { onMount } from 'svelte';
  import {
    AREAS_ATUACAO_OPTIONS,
    LGPD_CONSENT_TEXT,
    LGPD_CONTROLLER_NAME,
    LGPD_INSTAGRAM_HANDLE,
    LGPD_INSTAGRAM_URL,
    LGPD_PRIVACY_EMAIL,
    SELOS_OPTIONS,
    type AtaStatus,
    type BalancoStatus,
    type CaucCepimStatus,
    type CndStatus,
    type EstatutoStatus,
    type ExperienciaStatus,
    type PorteOrcamento
  } from '../../lib/diagnostico-scoring';

  // Organization & URL query state
  let cnpjInput = $state('');
  let cnpjLoading = $state(false);
  let cnpjError = $state<string | null>(null);
  let cnpjLoaded = $state(false);
  let manualOrgMode = $state(false);
  let preIdentifiedFromLink = $state(false);
  let editingCnpj = $state(false);
  let waPrefilledFromLink = $state(false);

  let razaoSocial = $state('');
  let uf = $state('');
  let municipio = $state('');
  let naturezaJuridica = $state('');
  let idadeCnpjAnos = $state(0);
  let cnaePrincipal = $state('');

  let origemContato = $state('Organico');
  let campanhaTag = $state('');

  // Contact fields
  let contatoNome = $state('');
  let contatoCargo = $state('Presidente / Diretoria');
  let contatoWhatsapp = $state('');
  let contatoEmail = $state('');

  // Diagnostic answers
  let selectedAreas = $state<string[]>([]);
  let estatuto = $state<EstatutoStatus | ''>('');
  let ata = $state<AtaStatus | ''>('');
  let cnd = $state<CndStatus | ''>('');
  let caucCepim = $state<CaucCepimStatus | ''>('');
  let balanco = $state<BalancoStatus | ''>('');
  let porteOrcamento = $state<PorteOrcamento | ''>('');
  let experiencia = $state<ExperienciaStatus | ''>('');
  let contaPjAtiva = $state<boolean | null>(null);
  let selectedSelos = $state<string[]>([]);
  let necessidadePrincipal = $state('');

  // LGPD
  let optInLgpd = $state(false);
  let showPrivacyPolicy = $state(false);

  // Submission state
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let result = $state<any>(null);

  const UFS = [
    'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
    'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
  ];

  const CARGOS = [
    'Presidente / Diretoria',
    'Coordenação / Projetos',
    'Administrativo / Financeiro',
    'Voluntário(a) / Conselheiro(a)'
  ];

  const hideCnpjBlock = $derived(preIdentifiedFromLink && !editingCnpj);
  const stepOffset = $derived(hideCnpjBlock ? 0 : 1);
  const totalBlocks = $derived(hideCnpjBlock ? 6 : 7);

  const completedBlocks = $derived(
    (hideCnpjBlock
      ? 0
      : cnpjLoaded || (manualOrgMode && razaoSocial.trim() && cnpjInput.replace(/\D/g, '').length === 14)
        ? 1
        : 0) +
      (contatoNome.trim() && (contatoWhatsapp.trim() || contatoEmail.trim()) ? 1 : 0) +
      (selectedAreas.length > 0 ? 1 : 0) +
      (estatuto && ata ? 1 : 0) +
      (cnd && caucCepim ? 1 : 0) +
      (balanco && porteOrcamento && contaPjAtiva !== null ? 1 : 0) +
      (experiencia && optInLgpd ? 1 : 0)
  );

  const progressPct = $derived(Math.round((completedBlocks / totalBlocks) * 100));

  function formatCnpjDisplay(raw: string): string {
    const d = (raw || '').replace(/\D/g, '').slice(0, 14);
    return d
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  }

  function formatPhoneDisplay(raw: string): string {
    let d = (raw || '').replace(/\D/g, '');
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
      d = d.slice(2);
    }
    if (d.length === 11) {
      return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    }
    if (d.length === 10) {
      return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    }
    return raw.trim();
  }

  function formatCurrency(val: number | null | undefined): string {
    if (!val || val <= 0) return 'Consultar no edital';
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      maximumFractionDigits: 0
    }).format(val);
  }

  function toggleArea(id: string) {
    if (selectedAreas.includes(id)) {
      selectedAreas = selectedAreas.filter((a) => a !== id);
    } else {
      selectedAreas = [...selectedAreas, id];
    }
  }

  function toggleSelo(id: string) {
    if (selectedSelos.includes(id)) {
      selectedSelos = selectedSelos.filter((s) => s !== id);
    } else {
      selectedSelos = [...selectedSelos, id];
    }
  }

  async function lookupCnpj(rawInput?: string) {
    const clean = (rawInput ?? cnpjInput).replace(/\D/g, '');
    if (clean.length !== 14) {
      cnpjError = 'Digite os 14 números do CNPJ para buscar os dados automaticamente.';
      return;
    }

    cnpjLoading = true;
    cnpjError = null;

    try {
      const res = await fetch(`/api/cnpj/${clean}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Não foi possível consultar este CNPJ automaticamente.');
      }

      razaoSocial = data.razao_social || data.nome_fantasia || '';
      uf = (data.uf || '').toUpperCase();
      municipio = data.municipio || '';
      naturezaJuridica = data.natureza_juridica || 'Associação Privada';
      cnaePrincipal = data.cnae_fiscal_descricao || '';

      if (data.data_inicio_atividade) {
        const start = new Date(data.data_inicio_atividade);
        if (!isNaN(start.getTime())) {
          const diffYears = (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
          idadeCnpjAnos = Math.max(0, Math.floor(diffYears));
        }
      }

      cnpjInput = formatCnpjDisplay(clean);
      cnpjLoaded = true;
      manualOrgMode = false;
      if (preIdentifiedFromLink) {
        editingCnpj = false;
      }
    } catch (err: any) {
      if (razaoSocial.trim() && uf) {
        // Fallback info already provided via link
        cnpjLoaded = true;
        manualOrgMode = false;
      } else {
        cnpjError = `${err?.message || 'Erro ao buscar CNPJ.'} Você pode preencher os dados básicos manualmente abaixo.`;
        manualOrgMode = true;
        editingCnpj = true;
      }
    } finally {
      cnpjLoading = false;
    }
  }

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    const qCnpj = params.get('cnpj');
    const qOrigem = params.get('origem');
    const qCampanha = params.get('campanha');
    const qRef = params.get('ref');
    const qRazao = params.get('razao');
    const qUf = params.get('uf');
    const qMun = params.get('mun');

    if (qOrigem && ['Lista', 'Indicacao', 'Organico'].includes(qOrigem)) {
      origemContato = qOrigem;
    }
    if (qCampanha || qRef) {
      campanhaTag = [qCampanha?.trim(), qRef?.trim()].filter(Boolean).join(' | ');
    }
    if (qRazao && qRazao.trim()) {
      razaoSocial = qRazao.trim();
    }
    if (qUf && qUf.trim()) {
      uf = qUf.trim().toUpperCase().slice(0, 2);
    }
    if (qMun && qMun.trim()) {
      municipio = qMun.trim();
    }

    if (qCnpj && qCnpj.replace(/\D/g, '').length === 14) {
      preIdentifiedFromLink = true;
      editingCnpj = false;
      cnpjInput = formatCnpjDisplay(qCnpj);
      await lookupCnpj(qCnpj);
    }
  });

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    submitError = null;

    const cleanCnpj = cnpjInput.replace(/\D/g, '');
    if (cleanCnpj.length !== 14) {
      submitError = 'Informe um CNPJ válido com 14 dígitos.';
      return;
    }
    if (!razaoSocial.trim() || !uf) {
      submitError = 'Clique em "Buscar CNPJ" (ou preencha razão social e UF) antes de continuar.';
      return;
    }
    if (!contatoNome.trim() || (!contatoWhatsapp.trim() && !contatoEmail.trim())) {
      submitError = 'Informe seu nome e pelo menos um contato (WhatsApp ou e-mail).';
      return;
    }
    if (selectedAreas.length === 0) {
      submitError = 'Selecione pelo menos uma área de atuação da organização.';
      return;
    }
    if (!estatuto || !ata || !cnd || !caucCepim || !balanco || !porteOrcamento || !experiencia || contaPjAtiva === null) {
      submitError = 'Responda todas as perguntas documentais e de gestão para calcularmos seu índice com precisão.';
      return;
    }
    if (!optInLgpd) {
      submitError = 'Marque a caixa de consentimento LGPD para visualizar seu diagnóstico.';
      return;
    }

    submitting = true;
    try {
      const res = await fetch('/api/diagnostico', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cnpj: cleanCnpj,
          razao_social: razaoSocial,
          uf,
          municipio,
          natureza_juridica: naturezaJuridica,
          idade_cnpj_anos: idadeCnpjAnos,
          cnae_principal: cnaePrincipal,
          contato_nome: contatoNome,
          contato_cargo: contatoCargo,
          contato_whatsapp: contatoWhatsapp,
          contato_email: contatoEmail,
          areas: selectedAreas,
          estatuto,
          ata,
          cnd,
          cauc_cepim: caucCepim,
          balanco,
          porte_orcamento: porteOrcamento,
          experiencia,
          conta_pj_ativa: contaPjAtiva,
          selos: selectedSelos,
          necessidade_principal: necessidadePrincipal,
          opt_in_lgpd: optInLgpd,
          origem_contato: origemContato,
          campanha_tag: campanhaTag
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao gerar diagnóstico.');
      }

      result = data;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      submitError = err?.message || 'Erro de conexão ao processar o diagnóstico.';
    } finally {
      submitting = false;
    }
  }

  function resetForm() {
    result = null;
    submitError = null;
    preIdentifiedFromLink = false;
    editingCnpj = true;
    cnpjLoaded = false;
    cnpjInput = '';
    razaoSocial = '';
    uf = '';
    municipio = '';
    naturezaJuridica = '';
    idadeCnpjAnos = 0;
    cnaePrincipal = '';
    waPrefilledFromLink = false;
  }
</script>

<svelte:head>
  <title>Autodiagnóstico Gratuito de Editais — Tríade Captação de Recursos</title>
  <meta
    name="description"
    content="Descubra em cerca de 3 minutos o índice de prontidão documental da sua OSC e veja editais abertos compatíveis com o seu CNPJ."
  />
</svelte:head>

<div class="min-h-screen bg-gradient-to-b from-teal-50/70 via-slate-50 to-white text-slate-800 pb-16">
  <!-- Top Brand Header -->
  <header class="bg-white border-b border-slate-200/80 sticky top-0 z-20 backdrop-blur bg-white/95">
    <div class="max-w-3xl mx-auto px-4 py-3.5 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2.5">
        <div class="w-9 h-9 rounded-xl bg-teal-700 text-white flex items-center justify-center font-bold text-lg shadow-sm">
          T
        </div>
        <div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <p class="text-sm font-bold text-slate-900 leading-tight">{LGPD_CONTROLLER_NAME}</p>
            <a
              href={LGPD_INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="text-[11px] font-semibold text-teal-700 hover:text-teal-900 hover:underline"
            >
              Instagram {LGPD_INSTAGRAM_HANDLE} ↗
            </a>
          </div>
          <p class="text-xs text-slate-500">Autodiagnóstico Gratuito de Prontidão para Editais</p>
        </div>
      </div>

      {#if !result}
        <div class="text-right">
          <span class="text-xs font-semibold text-teal-700">{progressPct}%</span>
          <div class="w-20 sm:w-28 h-1.5 bg-slate-200 rounded-full overflow-hidden mt-0.5">
            <div
              class="h-full bg-teal-600 transition-all duration-300"
              style="width: {progressPct}%"
            ></div>
          </div>
        </div>
      {/if}
    </div>
  </header>

  <div class="max-w-3xl mx-auto px-4 pt-6 sm:pt-8">
    {#if result}
      <!-- RESULTADO INSTANTÂNEO -->
      {@const ev = result.evaluation}
      {@const tierBadgeClass =
        ev.tier === 'Tier A'
          ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
          : ev.tier === 'Tier B'
            ? 'bg-amber-100 text-amber-800 border-amber-300'
            : 'bg-slate-200 text-slate-700 border-slate-300'}

      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden mb-6">
        <div class="bg-gradient-to-r from-teal-800 to-teal-700 px-6 py-6 text-white">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p class="text-xs uppercase tracking-wider text-teal-200 font-semibold">
                Relatório de Prontidão Documental
              </p>
              <h1 class="text-xl sm:text-2xl font-bold mt-1">{result.razaoSocial || 'Organização Avaliada'}</h1>
              <p class="text-xs sm:text-sm text-teal-100 mt-0.5">
                CNPJ {result.cnpj} • {result.municipio ? `${result.municipio}/` : ''}{result.uf}
              </p>
            </div>
            <div class="bg-white/10 backdrop-blur rounded-2xl px-5 py-3 text-center border border-white/20">
              <div class="text-3xl sm:text-4xl font-extrabold leading-none">{ev.score}</div>
              <div class="text-[11px] text-teal-100 mt-1">de 100 pontos</div>
            </div>
          </div>
        </div>

        <div class="p-6">
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold border {tierBadgeClass}">
              {ev.tier} — {ev.tierLabel}
            </span>
            {#if result.savedToSheet}
              <span class="text-xs text-emerald-700 font-medium">✓ Diagnóstico registrado com segurança</span>
            {/if}
          </div>

          <p class="text-sm text-slate-700 leading-relaxed">{ev.tierDescription}</p>

          {#if ev.travasPendentes.length > 0}
            <div class="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
              <p class="text-xs font-bold uppercase tracking-wide text-amber-900 mb-1.5">
                Travas documentais que impedem o nível "Pronta para Captar" hoje:
              </p>
              <ul class="list-disc pl-5 text-xs sm:text-sm text-amber-900 space-y-1">
                {#each ev.travasPendentes as trava}
                  <li>{trava}</li>
                {/each}
              </ul>
            </div>
          {/if}

          <div class="grid sm:grid-cols-2 gap-4 mt-5">
            <!-- Pontos Fortes -->
            <div class="bg-emerald-50/70 border border-emerald-200/80 rounded-xl p-4">
              <h2 class="text-xs font-bold uppercase tracking-wide text-emerald-900 mb-2">
                Pontos Fortes Identificados
              </h2>
              {#if ev.pontosFortes.length > 0}
                <ul class="space-y-1.5 text-xs sm:text-sm text-emerald-950">
                  {#each ev.pontosFortes as pf}
                    <li class="flex items-start gap-1.5">
                      <span class="text-emerald-600 font-bold">✓</span>
                      <span>{pf}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="text-xs text-slate-600">Comece regularizando os itens prioritários ao lado.</p>
              {/if}
            </div>

            <!-- Checklist de Regularização -->
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-4">
              <h2 class="text-xs font-bold uppercase tracking-wide text-slate-800 mb-2">
                Checklist de Próximos Passos
              </h2>
              {#if ev.pendencias.length > 0}
                <ul class="space-y-2.5 text-xs text-slate-700">
                  {#each ev.pendencias as p}
                    <li>
                      <div class="flex items-center gap-1.5 font-semibold text-slate-900">
                        <span
                          class="px-1.5 py-0.5 rounded text-[10px] font-bold {p.prioridade === 'Alta'
                            ? 'bg-rose-100 text-rose-800'
                            : 'bg-amber-100 text-amber-800'}"
                        >
                          {p.prioridade}
                        </span>
                        <span>{p.item}</span>
                      </div>
                      <p class="text-slate-600 mt-0.5">{p.detalhe}</p>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="text-xs sm:text-sm text-emerald-800 font-medium">
                  Excelente! Nenhuma pendência crítica encontrada nos itens avaliados.
                </p>
              {/if}
            </div>
          </div>
        </div>
      </div>

      <!-- TOP 3 EDITAIS COMPATÍVEIS -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
        <h2 class="text-lg font-bold text-slate-900">
          Oportunidades Abertas no Nosso Radar ({result.topEditais.length})
        </h2>
        <p class="text-xs text-slate-500 mt-1">
          Triagem inicial baseada no seu estado, tempo de CNPJ e áreas marcadas.
        </p>

        {#if result.topEditais.length > 0}
          <div class="space-y-3 mt-4">
            {#each result.topEditais as edital}
              <div class="border border-slate-200 rounded-xl p-4 hover:border-teal-300 transition-colors">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <h3 class="text-sm font-bold text-slate-900 flex-1">{edital.titulo}</h3>
                  <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-teal-50 text-teal-800 border border-teal-200">
                    {edital.abrangencia}
                  </span>
                </div>
                {#if edital.resumo}
                  <p class="text-xs text-slate-600 mt-1.5 leading-relaxed">{edital.resumo}</p>
                {/if}
                <div class="flex flex-wrap items-center justify-between gap-2 mt-3 pt-2.5 border-t border-slate-100 text-xs">
                  <div class="flex flex-wrap gap-3 text-slate-700">
                    <span><strong>Valor:</strong> {formatCurrency(edital.valor_maximo_reais)}</span>
                    <span><strong>Prazo:</strong> {edital.prazo}</span>
                  </div>
                  {#if edital.url}
                    <a
                      href={edital.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-teal-700 font-semibold hover:underline"
                    >
                      Ver edital →
                    </a>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <div class="mt-4 bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-600">
            No momento não encontramos editais abertos com prazo suficiente para este perfil específico, mas sua organização já foi registrada para receber avisos assim que novas chamadas compatíveis abrirem.
          </div>
        {/if}

        <p class="text-[11px] text-slate-500 mt-4 bg-slate-50 border border-slate-200 rounded-lg p-3">
          <strong>Aviso importante:</strong> Esta triagem inicial é informativa e <strong>não substitui o parecer técnico de elegibilidade</strong> nem representa garantia de aprovação ou repasse de recursos. O enquadramento final depende sempre da leitura completa de cada edital.
        </p>
      </div>

      <!-- CTA / AÇÕES -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onclick={resetForm}
          class="px-4 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          ← Avaliar outro CNPJ
        </button>

        <a
          href={`mailto:${LGPD_PRIVACY_EMAIL}?subject=${encodeURIComponent(`Autodiagnóstico Tríade — ${result.razaoSocial} (${ev.tier} / ${ev.score} pts)`)}&body=${encodeURIComponent(`Olá, equipe da Tríade!\n\nAcabamos de concluir o autodiagnóstico da ${result.razaoSocial} (CNPJ ${result.cnpj}), com resultado ${ev.score}/100 (${ev.tier} — ${ev.tierLabel}), e gostaríamos de conversar sobre oportunidades de captação.`)}`}
          class="px-5 py-2.5 rounded-xl bg-teal-700 text-white text-sm font-bold hover:bg-teal-800 shadow-sm"
        >
          Quero conversar com a equipe Tríade →
        </a>
      </div>
    {:else}
      <!-- INTRO -->
      <div class="mb-6">
        <span class="inline-block px-3 py-1 rounded-full bg-teal-100 text-teal-900 text-xs font-bold mb-2">
          Gratuito • Cerca de 3 minutos • Resultado na hora
        </span>
        <h1 class="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
          Sua organização está pronta para captar recursos em editais?
        </h1>
        <p class="text-sm text-slate-600 mt-2 leading-relaxed">
          Responda a {totalBlocks} blocos rápidos para receber na hora o <strong>Índice de Prontidão Documental (0 a 100)</strong>, um checklist do que falta regularizar e até <strong>3 editais abertos compatíveis</strong> com a sua organização — sem compromisso e sem promessa de aprovação.
        </p>
      </div>

      <form onsubmit={handleSubmit} class="space-y-5">
        {#if hideCnpjBlock}
          <!-- BANNER COMPACTO: OSC JÁ IDENTIFICADA PELO LINK PERSONALIZADO -->
          <section class="bg-teal-50/85 rounded-2xl border border-teal-200 p-4 sm:p-5 shadow-sm">
            {#if cnpjLoading}
              <div class="flex items-center gap-3 text-sm text-teal-900 font-medium">
                <span class="inline-block w-4 h-4 rounded-full border-2 border-teal-700 border-t-transparent animate-spin"></span>
                Identificando automaticamente os dados da sua organização...
              </div>
            {:else if cnpjLoaded}
              <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5">
                <div>
                  <span class="inline-block text-[11px] font-bold uppercase tracking-wide text-teal-800 bg-white/90 border border-teal-200 px-2.5 py-0.5 rounded-full mb-1.5">
                    ✓ Diagnóstico preparado para sua organização
                  </span>
                  <h2 class="text-base sm:text-lg font-extrabold text-teal-950 leading-snug">
                    {razaoSocial}
                  </h2>
                  <p class="text-xs sm:text-sm text-slate-700 mt-1">
                    {#if municipio || uf}{municipio}{municipio && uf ? '/' : ''}{uf} • {/if}
                    {idadeCnpjAnos} {idadeCnpjAnos === 1 ? 'ano' : 'anos'} de CNPJ • {cnpjInput}
                  </p>
                  {#if naturezaJuridica}
                    <p class="text-xs text-slate-500 mt-0.5">{naturezaJuridica}</p>
                  {/if}
                </div>
                <button
                  type="button"
                  onclick={() => (editingCnpj = true)}
                  class="self-start text-xs font-semibold text-teal-800 hover:text-teal-950 underline underline-offset-2 whitespace-nowrap"
                >
                  Não é sua OSC? Trocar CNPJ
                </button>
              </div>
            {/if}
          </section>
        {:else}
          <!-- BLOCO 1: CNPJ (exibido para acesso orgânico, indicação ou troca manual) -->
          <section class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <div class="flex items-center justify-between gap-2 mb-3">
              <div class="flex items-center gap-2">
                <span class="w-6 h-6 rounded-full bg-teal-700 text-white text-xs font-bold flex items-center justify-center">1</span>
                <h2 class="text-base font-bold text-slate-900">Identificação da OSC (CNPJ)</h2>
              </div>
              {#if preIdentifiedFromLink && cnpjLoaded}
                <button
                  type="button"
                  onclick={() => (editingCnpj = false)}
                  class="text-xs font-semibold text-teal-700 hover:underline"
                >
                  Concluir troca
                </button>
              {/if}
            </div>

            <div class="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                inputmode="numeric"
                placeholder="00.000.000/0001-00"
                value={cnpjInput}
                oninput={(e) => (cnpjInput = formatCnpjDisplay((e.target as HTMLInputElement).value))}
                class="flex-1 px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none"
                required
              />
              <button
                type="button"
                onclick={() => lookupCnpj()}
                disabled={cnpjLoading}
                class="px-5 py-2.5 rounded-xl bg-teal-700 text-white text-sm font-semibold hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap"
              >
                {cnpjLoading ? 'Buscando...' : 'Buscar CNPJ'}
              </button>
            </div>

            {#if cnpjError}
              <p class="text-xs text-amber-700 mt-2">{cnpjError}</p>
            {/if}

            {#if cnpjLoaded}
              <div class="mt-3.5 bg-teal-50/70 border border-teal-200 rounded-xl p-3.5 text-xs sm:text-sm">
                <div class="flex items-center justify-between gap-2">
                  <p class="font-bold text-teal-950">{razaoSocial}</p>
                  <span class="text-[11px] font-semibold px-2 py-0.5 rounded bg-white text-teal-800 border border-teal-200">
                    {idadeCnpjAnos} {idadeCnpjAnos === 1 ? 'ano' : 'anos'} de CNPJ
                  </span>
                </div>
                <p class="text-slate-600 mt-1">
                  {municipio}/{uf} • {naturezaJuridica}
                </p>
                {#if cnaePrincipal}
                  <p class="text-xs text-slate-500 mt-0.5">CNAE: {cnaePrincipal}</p>
                {/if}
              </div>
            {/if}

            {#if manualOrgMode}
              <div class="grid sm:grid-cols-3 gap-3 mt-3.5 pt-3 border-t border-slate-100">
                <div class="sm:col-span-2">
                  <label class="block text-xs font-semibold text-slate-700 mb-1" for="manual-razao">Razão Social / Nome da OSC *</label>
                  <input
                    id="manual-razao"
                    type="text"
                    bind:value={razaoSocial}
                    class="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    required
                  />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-slate-700 mb-1" for="manual-uf">Estado (UF) *</label>
                  <select id="manual-uf" bind:value={uf} class="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white" required>
                    <option value="">Selecione</option>
                    {#each UFS as u}
                      <option value={u}>{u}</option>
                    {/each}
                  </select>
                </div>
                <div>
                  <label class="block text-xs font-semibold text-slate-700 mb-1" for="manual-mun">Município</label>
                  <input id="manual-mun" type="text" bind:value={municipio} class="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm" />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-slate-700 mb-1" for="manual-idade">Anos de CNPJ</label>
                  <input id="manual-idade" type="number" min="0" max="150" bind:value={idadeCnpjAnos} class="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm" />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-slate-700 mb-1" for="manual-nat">Natureza Jurídica</label>
                  <input id="manual-nat" type="text" bind:value={naturezaJuridica} placeholder="Associação / Fundação" class="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm" />
                </div>
              </div>
            {/if}
          </section>
        {/if}

        <!-- BLOCO CONTATO -->
        <section class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div class="flex items-center gap-2 mb-3">
            <span class="w-6 h-6 rounded-full bg-teal-700 text-white text-xs font-bold flex items-center justify-center">{1 + stepOffset}</span>
            <h2 class="text-base font-bold text-slate-900">Quem está respondendo?</h2>
          </div>

          <div class="grid sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="contato-nome">Seu nome *</label>
              <input
                id="contato-nome"
                type="text"
                bind:value={contatoNome}
                placeholder="Ex.: Maria Silva"
                class="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-sm"
                required
              />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="contato-cargo">Cargo / Papel</label>
              <select id="contato-cargo" bind:value={contatoCargo} class="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-sm bg-white">
                {#each CARGOS as c}
                  <option value={c}>{c}</option>
                {/each}
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="contato-wa">
                WhatsApp (com DDD) *
                {#if waPrefilledFromLink}
                  <span class="font-normal text-teal-700 ml-1">✓ preenchido</span>
                {/if}
              </label>
              <input
                id="contato-wa"
                type="tel"
                bind:value={contatoWhatsapp}
                placeholder="(00) 99999-9999"
                class="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-sm"
              />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="contato-email">E-mail institucional</label>
              <input
                id="contato-email"
                type="email"
                bind:value={contatoEmail}
                placeholder="contato@organizacao.org.br"
                class="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-sm"
              />
            </div>
          </div>
        </section>

        <!-- BLOCO 3: ÁREAS DE ATUAÇÃO -->
        <section class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div class="flex items-center gap-2 mb-1">
            <span class="w-6 h-6 rounded-full bg-teal-700 text-white text-xs font-bold flex items-center justify-center">{2 + stepOffset}</span>
            <h2 class="text-base font-bold text-slate-900">Principais áreas de atuação *</h2>
          </div>
          <p class="text-xs text-slate-500 mb-3">Toque em todas as áreas em que sua organização atua hoje.</p>

          <div class="flex flex-wrap gap-2">
            {#each AREAS_ATUACAO_OPTIONS as area}
              {@const active = selectedAreas.includes(area.id)}
              <button
                type="button"
                onclick={() => toggleArea(area.id)}
                class="px-3.5 py-2 rounded-xl text-xs sm:text-sm font-medium border transition-all {active
                  ? 'bg-teal-700 text-white border-teal-700 shadow-sm'
                  : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-teal-400'}"
              >
                {active ? '✓ ' : ''}{area.label}
              </button>
            {/each}
          </div>
        </section>

        <!-- BLOCO 4: DOCUMENTAÇÃO JURÍDICA BASE -->
        <section class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-teal-700 text-white text-xs font-bold flex items-center justify-center">{3 + stepOffset}</span>
            <h2 class="text-base font-bold text-slate-900">Documentação Jurídica Base *</h2>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-2">Estatuto Social registrado em cartório:</p>
            <div class="grid sm:grid-cols-3 gap-2">
              {#each [
                { v: 'sim', l: 'Sim, registrado e atualizado' },
                { v: 'atualizar', l: 'Registrado, precisa atualizar' },
                { v: 'nao', l: 'Não possui / em formação' }
              ] as opt}
                <button
                  type="button"
                  onclick={() => (estatuto = opt.v as EstatutoStatus)}
                  class="text-left px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {estatuto === opt.v
                    ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
                >
                  {opt.l}
                </button>
              {/each}
            </div>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-2">Ata de Eleição da Diretoria atual (registrada):</p>
            <div class="grid sm:grid-cols-3 gap-2">
              {#each [
                { v: 'vigente_6m', l: 'Vigente (+6 meses de mandato)' },
                { v: 'vence_breve', l: 'Vigente, vence em até 6 meses' },
                { v: 'vencida', l: 'Vencida ou sem ata registrada' }
              ] as opt}
                <button
                  type="button"
                  onclick={() => (ata = opt.v as AtaStatus)}
                  class="text-left px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {ata === opt.v
                    ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
                >
                  {opt.l}
                </button>
              {/each}
            </div>
          </div>
        </section>

        <!-- BLOCO 5: REGULARIDADE FISCAL & MROSC -->
        <section class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-teal-700 text-white text-xs font-bold flex items-center justify-center">{4 + stepOffset}</span>
            <h2 class="text-base font-bold text-slate-900">Regularidade Fiscal e MROSC *</h2>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-2">
              Certidões Negativas (Receita Federal, FGTS e Trabalhista — CNDT):
            </p>
            <div class="grid sm:grid-cols-3 gap-2">
              {#each [
                { v: 'em_dia', l: 'Todas em dia / emitíveis hoje' },
                { v: 'regularizando', l: 'Alguma pendência em regularização' },
                { v: 'nao_sei', l: 'Vencidas ou não sei informar' }
              ] as opt}
                <button
                  type="button"
                  onclick={() => (cnd = opt.v as CndStatus)}
                  class="text-left px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {cnd === opt.v
                    ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
                >
                  {opt.l}
                </button>
              {/each}
            </div>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-1">
              Adimplência no CAUC, CEPIM e Transferegov (art. 39 da Lei 13.019/2014):
            </p>
            <p class="text-[11px] text-slate-500 mb-2">
              Verifica se há contas reprovadas ou impedimentos para firmar convênios e termos de fomento públicos.
            </p>
            <div class="grid sm:grid-cols-3 gap-2">
              {#each [
                { v: 'em_dia', l: 'Em dia / sem impedimentos' },
                { v: 'regularizando', l: 'Pendência em regularização' },
                { v: 'pendencia_ou_nao_sei', l: 'Com pendência ou não sei' }
              ] as opt}
                <button
                  type="button"
                  onclick={() => (caucCepim = opt.v as CaucCepimStatus)}
                  class="text-left px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {caucCepim === opt.v
                    ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
                >
                  {opt.l}
                </button>
              {/each}
            </div>
          </div>
        </section>

        <!-- BLOCO 6: FINANCEIRO, PORTE & CONTA PJ -->
        <section class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-teal-700 text-white text-xs font-bold flex items-center justify-center">{5 + stepOffset}</span>
            <h2 class="text-base font-bold text-slate-900">Gestão Financeira e Porte *</h2>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-2">Balanço Patrimonial e DRE dos últimos 2 anos (assinados por contador):</p>
            <div class="grid sm:grid-cols-3 gap-2">
              {#each [
                { v: 'sim_2anos', l: 'Sim, últimos 2 anos completos' },
                { v: 'parcial_1ano', l: 'Apenas 1 ano ou parcial' },
                { v: 'nao', l: 'Não possui ainda' }
              ] as opt}
                <button
                  type="button"
                  onclick={() => (balanco = opt.v as BalancoStatus)}
                  class="text-left px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {balanco === opt.v
                    ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
                >
                  {opt.l}
                </button>
              {/each}
            </div>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-1">
              Orçamento anual aproximado <span class="font-normal text-slate-500">(usado apenas para indicar editais do porte certo — não reduz sua nota)</span>:
            </p>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {#each [
                { v: 'ate_100k', l: 'Até R$ 100 mil' },
                { v: '100k_500k', l: 'R$ 100k a R$ 500k' },
                { v: '500k_2m', l: 'R$ 500k a R$ 2M' },
                { v: 'acima_2m', l: 'Acima de R$ 2M' }
              ] as opt}
                <button
                  type="button"
                  onclick={() => (porteOrcamento = opt.v as PorteOrcamento)}
                  class="text-center px-3 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {porteOrcamento === opt.v
                    ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
                >
                  {opt.l}
                </button>
              {/each}
            </div>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-2">Possui conta bancária PJ ativa em nome do CNPJ da organização?</p>
            <div class="grid grid-cols-2 gap-2 max-w-sm">
              <button
                type="button"
                onclick={() => (contaPjAtiva = true)}
                class="px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {contaPjAtiva === true
                  ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
              >
                Sim, conta PJ ativa
              </button>
              <button
                type="button"
                onclick={() => (contaPjAtiva = false)}
                class="px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {contaPjAtiva === false
                  ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
              >
                Ainda não
              </button>
            </div>
          </div>
        </section>

        <!-- BLOCO 7: EXPERIÊNCIA, SELOS, NECESSIDADE & LGPD -->
        <section class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-teal-700 text-white text-xs font-bold flex items-center justify-center">{6 + stepOffset}</span>
            <h2 class="text-base font-bold text-slate-900">Experiência, Selos e Prioridade *</h2>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-2">Experiência anterior com editais ou convênios:</p>
            <div class="grid sm:grid-cols-3 gap-2">
              {#each [
                { v: 'executou', l: 'Já executou e prestou contas' },
                { v: 'submeteu', l: 'Já participou sem aprovação' },
                { v: 'primeira_vez', l: 'Primeira vez buscando editais' }
              ] as opt}
                <button
                  type="button"
                  onclick={() => (experiencia = opt.v as ExperienciaStatus)}
                  class="text-left px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium transition-all {experiencia === opt.v
                    ? 'bg-teal-50 border-teal-600 text-teal-950 ring-1 ring-teal-600'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300'}"
                >
                  {opt.l}
                </button>
              {/each}
            </div>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-700 mb-2">Certificações e conselhos (opcional — marque os que possuir):</p>
            <div class="flex flex-wrap gap-2">
              {#each SELOS_OPTIONS as selo}
                {@const active = selectedSelos.includes(selo.id)}
                <button
                  type="button"
                  onclick={() => toggleSelo(selo.id)}
                  class="px-3 py-1.5 rounded-xl text-xs font-medium border transition-all {active
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-teal-400'}"
                >
                  {active ? '✓ ' : ''}{selo.label}
                </button>
              {/each}
            </div>
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1" for="necessidade-input">
              Qual projeto ou estrutura é prioridade hoje na sua organização? (opcional)
            </label>
            <textarea
              id="necessidade-input"
              rows="2"
              bind:value={necessidadePrincipal}
              placeholder="Ex.: reforma do espaço comunitário, compra de equipamentos, equipe técnica ou oficinas..."
              class="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-teal-500 outline-none"
            ></textarea>
          </div>

          <!-- LGPD BLOCK -->
          <div class="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <label class="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                bind:checked={optInLgpd}
                class="mt-1 h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                required
              />
              <span class="text-xs text-slate-700 leading-relaxed">
                <strong>Consentimento LGPD (obrigatório):</strong> {LGPD_CONSENT_TEXT}
              </span>
            </label>

            <button
              type="button"
              onclick={() => (showPrivacyPolicy = !showPrivacyPolicy)}
              class="text-[11px] text-teal-700 font-semibold hover:underline mt-2 ml-7"
            >
              {showPrivacyPolicy ? 'Ocultar política curta de privacidade' : 'Ler política curta de privacidade (LGPD)'}
            </button>

            {#if showPrivacyPolicy}
              <div class="mt-2 ml-7 text-[11px] text-slate-600 space-y-1 bg-white border border-slate-200 rounded-lg p-3">
                <p><strong>Controladora:</strong> {LGPD_CONTROLLER_NAME}.</p>
                <p><strong>Finalidade:</strong> calcular seu Índice de Prontidão Documental, exibir editais compatíveis e possibilitar contato futuro apenas quando houver oportunidades alinhadas ao perfil da OSC.</p>
                <p><strong>Compartilhamento:</strong> os dados não são vendidos nem divulgados publicamente; o acesso é restrito à equipe interna de captação.</p>
                <p><strong>Exclusão e direitos do titular:</strong> a qualquer momento você pode solicitar correção ou exclusão definitiva pelo e-mail <strong>{LGPD_PRIVACY_EMAIL}</strong>.</p>
              </div>
            {/if}
          </div>
        </section>

        {#if submitError}
          <div class="bg-rose-50 border border-rose-200 text-rose-800 text-sm rounded-xl p-4 font-medium">
            {submitError}
          </div>
        {/if}

        <button
          type="submit"
          disabled={submitting}
          class="w-full py-3.5 px-6 rounded-2xl bg-teal-700 text-white text-base font-bold hover:bg-teal-800 shadow-md disabled:opacity-60 transition-all"
        >
          {submitting ? 'Calculando diagnóstico e buscando editais...' : 'Gerar Meu Diagnóstico Gratuito →'}
        </button>
      </form>
    {/if}
  </div>
</div>
