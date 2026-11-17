import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_FILE = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');
const ARCHIVE_FILE = path.join(process.cwd(), 'src', 'data', 'editais_historico.json');
const STATE_FILE = path.join(process.cwd(), 'src', 'data', 'extra_sources_state.json');

const BRAVE_SEARCH_API_KEY = (process.env.BRAVE_SEARCH_API_KEY || '').trim();
const FORCE_FOUNDATIONS_SEARCH = process.env.FORCE_FOUNDATIONS_SEARCH === 'true';

const MAX_PNCP_NEW = parseInt(process.env.MAX_PNCP_NEW || '20', 10);
const MAX_MAPAS_NEW = parseInt(process.env.MAX_MAPAS_NEW || '15', 10);
const MAX_FOUNDATIONS_NEW = parseInt(process.env.MAX_FOUNDATIONS_NEW || '10', 10);

interface ExtraSourcesState {
  last_foundations_run_at?: string;
  seen_foundation_urls: string[];
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeDateOnly(raw?: string | null): string | null {
  const val = String(raw || '').trim();
  if (!val) return null;
  const iso = val.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const br = val.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

function formatPncpDateParam(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function stripHtmlToText(html: string): string {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPdfLinkFromHtml(html: string, baseUrl: string): string | null {
  const matches = [...(html || '').matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)];
  if (matches.length === 0) return null;

  let bestUrl: string | null = null;
  let bestScore = -Infinity;

  for (const m of matches) {
    const rawHref = m[1].trim();
    if (!rawHref) continue;
    let absUrl = rawHref;
    try {
      absUrl = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }
    const lower = normalizeText(absUrl);
    let score = 0;
    if (lower.includes('edital')) score += 100;
    if (lower.includes('chamada') || lower.includes('regulamento')) score += 80;
    if (lower.includes('retifica') || lower.includes('prorroga')) score += 90;
    if (lower.includes('anexo') || lower.includes('formulario') || lower.includes('modelo')) score -= 40;
    if (lower.includes('relatorio') || lower.includes('balanco') || lower.includes('estatuto')) score -= 120;

    if (score > bestScore) {
      bestScore = score;
      bestUrl = absUrl;
    }
  }

  return bestScore >= -20 ? bestUrl : null;
}

async function isReachablePdf(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TriadeMatchmaker/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) return false;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 4) return false;
    const bytes = new Uint8Array(buf, 0, 4);
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  } catch {
    return false;
  }
}

function buildDedupSignature(nome: string, dataFim?: string | null): string {
  const cleanName = normalizeText(nome).replace(/[^a-z0-9]/g, '').slice(0, 70);
  return `${cleanName}::${dataFim || 'nodate'}`;
}

async function fetchJsonSafe(url: string, timeoutMs = 10000): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'TriadeMatchmaker/1.0' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- SOURCE 1: PNCP (Portal Nacional de Contratações Públicas) ---
async function collectFromPncp(
  seenIds: Set<string>,
  seenUrls: Set<string>,
  seenSignatures: Set<string>,
  todayIso: string
): Promise<any[]> {
  const results: any[] = [];
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 10);

  const dataInicial = formatPncpDateParam(startDate);
  const dataFinal = formatPncpDateParam(endDate);

  // Modalidade 3 = Concurso, 12 = Credenciamento / Chamamento Público
  const modalities = [3, 12];

  const includePatterns = [
    'sem fins lucrativos',
    'organizacao social',
    'organizacoes sociais',
    'organizacao da sociedade civil',
    'organizacoes da sociedade civil',
    'termo de fomento',
    'termo de colaboracao',
    'acordo de cooperacao',
    'mrosc',
    'chamamento publico',
    'chamada publica',
    'agricultura familiar',
    'pnae',
    'aldir blanc',
    'paulo gustavo',
    'fomento a cultura',
    'fomento cultural',
    'projetos sociais',
    'entidades sociais',
    'entidades sem fins',
    'terceiro setor',
    'assistencia social',
    'acolhimento institucional'
  ];

  const strongMroscPatterns = [
    'sem fins lucrativos',
    'organizacao social',
    'organizacao da sociedade civil',
    'termo de fomento',
    'termo de colaboracao',
    'mrosc',
    'terceiro setor',
    'entidades sem fins'
  ];

  const excludePatterns = [
    'consignacao',
    'consignacoes',
    'consignado',
    'leilao',
    'leiloeiro',
    'pessoa fisica',
    'cartorio',
    'tabelionato',
    'serventia',
    'credenciamento de empresas',
    'credenciamento de clinicas',
    'credenciamento medico',
    'servicos medicos',
    'consultas medicas',
    'exames medicos',
    'exames laboratoriais',
    'credenciamento de hoteis',
    'hospedagem',
    'passagens aereas',
    'combustivel',
    'lubrificante',
    'pecas automotivas',
    'manutencao de veiculos',
    'aquisicao de veiculo',
    'aluguel de veiculos',
    'material de expediente',
    'material de limpeza',
    'prestacao de servicos graficos'
  ];

  for (const mod of modalities) {
    if (results.length >= MAX_PNCP_NEW) break;

    for (let page = 1; page <= 2; page++) {
      if (results.length >= MAX_PNCP_NEW) break;

      const url = `https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?dataInicial=${dataInicial}&dataFinal=${dataFinal}&codigoModalidadeContratacao=${mod}&pagina=${page}&tamanhoPagina=50`;
      const payload = await fetchJsonSafe(url, 12000);
      const items: any[] = payload?.data || [];
      if (items.length === 0) break;

      for (const item of items) {
        if (results.length >= MAX_PNCP_NEW) break;
        if (!item?.numeroControlePNCP || !item?.orgaoEntidade?.cnpj) continue;

        const sitNorm = normalizeText(item.situacaoCompraNome || '');
        if (sitNorm.includes('anulad') || sitNorm.includes('revogad') || sitNorm.includes('suspens')) {
          continue;
        }

        const closingDate = normalizeDateOnly(item.dataEncerramentoProposta);
        if (closingDate && closingDate < todayIso) {
          continue;
        }

        const combinedNorm = normalizeText(`${item.objetoCompra || ''} ${item.informacaoComplementar || ''}`);
        if (excludePatterns.some(kw => combinedNorm.includes(kw))) {
          continue;
        }
        const hasOscToken = /\boscs?\b/.test(combinedNorm);
        if (!hasOscToken && !includePatterns.some(kw => combinedNorm.includes(kw))) {
          continue;
        }

        const valor = Number(item.valorTotalEstimado) || 0;
        const isStrongMrosc = hasOscToken || strongMroscPatterns.some(kw => combinedNorm.includes(kw));
        if (valor < 100000 && !(valor === 0 && isStrongMrosc)) {
          continue;
        }

        const id = `pncp_${String(item.numeroControlePNCP).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const publicUrl = `https://pncp.gov.br/app/editais/${item.orgaoEntidade.cnpj}/${item.anoCompra}/${item.sequencialCompra}`;
        const rawTitle = String(item.objetoCompra || `Chamamento PNCP ${item.numeroControlePNCP}`).replace(/\s+/g, ' ').trim();
        const shortTitle = rawTitle.length > 160 ? rawTitle.slice(0, 157).trim() + '...' : rawTitle;
        const sig = buildDedupSignature(shortTitle, closingDate);

        if (seenIds.has(id) || seenUrls.has(publicUrl) || seenSignatures.has(sig)) {
          continue;
        }

        // Fetch attached official files from PNCP
        let pdfLink: string | undefined;
        const filesUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${item.orgaoEntidade.cnpj}/compras/${item.anoCompra}/${item.sequencialCompra}/arquivos`;
        const filesList = await fetchJsonSafe(filesUrl, 8000);
        if (Array.isArray(filesList)) {
          const activeFiles = filesList.filter((f: any) => f?.statusAtivo !== false && (f?.url || f?.uri));
          let bestFileUrl: string | undefined;
          let bestFileScore = -Infinity;

          for (const f of activeFiles) {
            const docUrl = String(f.url || f.uri);
            const docTitle = normalizeText(f.titulo || '');
            let score = 0;
            if (docTitle.includes('edital') || docTitle.includes('chamamento') || docTitle.includes('regulamento')) score += 100;
            if (docTitle.includes('retifica') || docTitle.includes('prorroga')) score += 110;
            if (docTitle.includes('termo')) score += 40;
            if (docTitle.includes('anexo') || docTitle.includes('planilha') || docTitle.includes('modelo')) score -= 40;
            if (score > bestFileScore) {
              bestFileScore = score;
              bestFileUrl = docUrl;
            }
          }
          pdfLink = bestFileUrl;
        }

        const uf = item.unidadeOrgao?.ufSigla || '';
        const municipio = item.unidadeOrgao?.municipioNome || '';
        const orgaoNome = item.orgaoEntidade?.razaoSocial || 'Órgão Público';
        const openDate = normalizeDateOnly(item.dataAberturaProposta || item.dataPublicacaoPncp);

        const fullTextParts = [
          `FONTE: Portal Nacional de Contratações Públicas (PNCP)`,
          `Órgão / Patrocinador: ${orgaoNome} (CNPJ: ${item.orgaoEntidade.cnpj})`,
          `Modalidade: ${item.modalidadeNome || `Código ${mod}`}`,
          `Localidade: ${municipio ? `${municipio} - ` : ''}${uf || 'Nacional'}`,
          valor > 0 ? `Valor Total Estimado: R$ ${valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '',
          openDate ? `Abertura: ${openDate}` : '',
          closingDate ? `Encerramento das propostas: ${closingDate}` : '',
          `Objeto: ${rawTitle}`,
          item.informacaoComplementar ? `Informações Complementares: ${item.informacaoComplementar}` : '',
          item.linkSistemaOrigem ? `Sistema de Origem: ${item.linkSistemaOrigem}` : ''
        ].filter(Boolean);

        const record = {
          id,
          source_portal: 'PNCP',
          attributes: {
            nome: shortTitle,
            data_inicio: openDate || undefined,
            data_fim: closingDate || undefined,
            valor_total: valor > 0 ? valor : undefined,
            patrocinador: orgaoNome,
            locais: uf ? [{ municipio: municipio || undefined, uf }] : [],
            areas_interesse: ['Chamamento Público / MROSC']
          },
          public_url: publicUrl,
          pdf_link: pdfLink,
          full_text: fullTextParts.join('\n').slice(0, 14000),
          pipeline_status: 'PENDING_EXTRACTION'
        };

        seenIds.add(id);
        seenUrls.add(publicUrl);
        seenSignatures.add(sig);
        results.push(record);

        await sleep(250);
      }

      if ((payload?.paginasRestantes ?? 0) <= 0) break;
    }
  }

  return results;
}

// --- SOURCE 2: Mapas Culturais State Portals (No Cloudflare) ---
async function collectFromMapasCulturais(
  seenIds: Set<string>,
  seenUrls: Set<string>,
  seenSignatures: Set<string>,
  todayIso: string
): Promise<any[]> {
  const results: any[] = [];
  const portals = [
    { uf: 'ES', name: 'Mapa Cultural ES', baseUrl: 'https://mapa.cultura.es.gov.br' },
    { uf: 'CE', name: 'Mapa Cultural CE', baseUrl: 'https://mapacultural.secult.ce.gov.br' },
    { uf: 'PB', name: 'Mapa Cultural PB', baseUrl: 'https://mapacultural.pb.gov.br' },
    { uf: 'PA', name: 'Mapa Cultural PA', baseUrl: 'https://mapacultural.pa.gov.br' },
    { uf: 'SE', name: 'Mapa Cultural SE', baseUrl: 'https://mapacultural.se.gov.br' },
    { uf: 'RN', name: 'Mapa Cultural RN', baseUrl: 'https://mapacultural.natal.rn.gov.br' }
  ];

  const maxFutureDate = new Date();
  maxFutureDate.setDate(maxFutureDate.getDate() + 540);
  const maxFutureIso = maxFutureDate.toISOString().split('T')[0];

  const maxPerPortal = Math.max(3, Math.ceil(MAX_MAPAS_NEW / 4));

  for (const portal of portals) {
    if (results.length >= MAX_MAPAS_NEW) break;

    const apiUrl = `${portal.baseUrl}/api/opportunity/find?%40select=id,name,shortDescription,longDescription,type,registrationFrom,registrationTo,singleUrl,files&registrationTo=GTE(${todayIso})&%40limit=40`;
    const opps = await fetchJsonSafe(apiUrl, 8000);
    if (!Array.isArray(opps)) {
      console.log(`[ExtraSources][Mapas] Skipped ${portal.name} (unavailable or non-JSON).`);
      continue;
    }

    let portalCount = 0;

    for (const opp of opps) {
      if (results.length >= MAX_MAPAS_NEW || portalCount >= maxPerPortal) break;
      if (!opp?.id || !opp?.name) continue;

      const title = String(opp.name).replace(/\s+/g, ' ').trim();
      const titleNorm = normalizeText(title);
      const typeNorm = normalizeText(opp.type?.name || '');

      // Exclude courses, workshops, registries, committee elections, and peer-reviewer calls
      if (
        titleNorm.includes('parecerista') ||
        titleNorm.includes('aula de') ||
        titleNorm.includes('aulas de') ||
        titleNorm.includes('cadastro estadual') ||
        titleNorm.includes('adesao ao sistema') ||
        titleNorm.includes('eleitor') ||
        titleNorm.includes('candidatura') ||
        titleNorm.includes('comite executivo') ||
        titleNorm.includes('cotas raciais') ||
        titleNorm.includes('conselho ') ||
        titleNorm.includes('conferencia') ||
        typeNorm.includes('oficina') ||
        typeNorm.includes('curso') ||
        typeNorm.includes('campanha')
      ) {
        continue;
      }

      const isEditalLike =
        typeNorm.includes('edital') ||
        typeNorm.includes('fomento') ||
        typeNorm.includes('premio') ||
        typeNorm.includes('chamamento') ||
        typeNorm.includes('selecao') ||
        titleNorm.includes('edital') ||
        titleNorm.includes('chamamento') ||
        titleNorm.includes('chamada') ||
        titleNorm.includes('fomento') ||
        titleNorm.includes('aldir blanc') ||
        titleNorm.includes('paulo gustavo') ||
        titleNorm.includes('pnab');

      if (!isEditalLike) continue;

      const closeDate = normalizeDateOnly(opp.registrationTo?.date);
      if (!closeDate || closeDate < todayIso || closeDate > maxFutureIso) continue;
      const openDate = normalizeDateOnly(opp.registrationFrom?.date);

      let pdfLink: string | undefined;
      const rulesUrl = opp.files?.rules?.url;
      if (rulesUrl && String(rulesUrl).toLowerCase().includes('.pdf')) {
        pdfLink = String(rulesUrl);
      } else if (Array.isArray(opp.files?.downloads)) {
        const pdfDl = opp.files.downloads.find((d: any) => {
          const n = normalizeText(d?.name || '');
          const u = String(d?.url || '').toLowerCase();
          return u.endsWith('.pdf') && (n.includes('edital') || n.includes('chamada') || n.includes('regulamento'));
        });
        if (pdfDl?.url) pdfLink = String(pdfDl.url);
      }

      const rawDesc = stripHtmlToText(`${opp.shortDescription || ''}\n${opp.longDescription || ''}`);
      if (!pdfLink && rawDesc.length < 300) {
        continue;
      }

      const id = `mapas_${portal.uf.toLowerCase()}_${opp.id}`;
      const publicUrl = String(opp.singleUrl || `${portal.baseUrl}/oportunidade/${opp.id}/`);
      const sig = buildDedupSignature(title, closeDate);

      if (seenIds.has(id) || seenUrls.has(publicUrl) || seenSignatures.has(sig)) {
        continue;
      }

      const fullText = [
        `FONTE: ${portal.name}`,
        `Título: ${title}`,
        `Estado (UF): ${portal.uf}`,
        opp.type?.name ? `Tipo: ${opp.type.name}` : '',
        openDate ? `Início das inscrições: ${openDate}` : '',
        `Encerramento das inscrições: ${closeDate}`,
        rawDesc ? `Descrição:\n${rawDesc}` : ''
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 14000);

      const record = {
        id,
        source_portal: `Mapas Culturais ${portal.uf}`,
        attributes: {
          nome: title,
          data_inicio: openDate || undefined,
          data_fim: closeDate,
          patrocinador: portal.name,
          locais: [{ uf: portal.uf }],
          areas_interesse: ['Cultura', opp.type?.name || 'Edital Cultural']
        },
        public_url: publicUrl,
        pdf_link: pdfLink,
        full_text: fullText,
        pipeline_status: 'PENDING_EXTRACTION'
      };

      seenIds.add(id);
      seenUrls.add(publicUrl);
      seenSignatures.add(sig);
      results.push(record);
      portalCount++;
    }
  }

  return results;
}

// --- SOURCE 3: Weekly Corporate Foundations Discovery via Brave Search ---
async function collectFromFoundationsBrave(
  seenIds: Set<string>,
  seenUrls: Set<string>,
  seenSignatures: Set<string>,
  state: ExtraSourcesState
): Promise<{ records: any[]; ranSearch: boolean }> {
  if (!BRAVE_SEARCH_API_KEY) {
    return { records: [], ranSearch: false };
  }

  if (!FORCE_FOUNDATIONS_SEARCH && state.last_foundations_run_at) {
    const lastMs = new Date(state.last_foundations_run_at).getTime();
    const diffDays = (Date.now() - lastMs) / (1000 * 60 * 60 * 24);
    if (!Number.isNaN(lastMs) && diffDays < 7) {
      console.log(`[ExtraSources][Foundations] Skipping weekly Brave check (last run ${diffDays.toFixed(1)}d ago).`);
      return { records: [], ranSearch: false };
    }
  }

  const queries = [
    'site:itausocial.org.br (edital OR "chamada pública" OR fomento) (2026 OR 2027)',
    '(site:fbb.org.br OR site:fundacaobunge.org.br) (edital OR "chamada pública" OR seleção) (2026 OR 2027)',
    '(site:petrobras.com.br OR site:vale.com) (edital OR "chamada pública" OR seleção) (socioambiental OR cultura OR social) (2026 OR 2027)',
    'site:bndes.gov.br (chamada OR edital) ("fundo social" OR fomento OR cultura OR OSC) (2026 OR 2027)',
    '"edital" ("chamada pública" OR "seleção de projetos") ("Itaú Social" OR "Instituto C&A" OR "Fundação Telefônica" OR "Instituto Sabin" OR "Instituto Vedacit") (2026 OR 2027)'
  ];

  const stateSeenSet = new Set(state.seen_foundation_urls || []);
  const candidates: { url: string; title: string; snippet: string }[] = [];

  for (const q of queries) {
    try {
      const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6`;
      const res = await fetch(apiUrl, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_SEARCH_API_KEY
        },
        signal: AbortSignal.timeout(10000)
      });

      if (res.ok) {
        const data: any = await res.json();
        for (const r of data?.web?.results || []) {
          if (r?.url && !stateSeenSet.has(r.url) && !seenUrls.has(r.url)) {
            candidates.push({
              url: String(r.url),
              title: String(r.title || '').trim(),
              snippet: String(r.description || '').trim()
            });
          }
        }
      } else {
        console.warn(`[ExtraSources][Foundations] Brave HTTP ${res.status} for query.`);
      }
    } catch (e: any) {
      console.warn(`[ExtraSources][Foundations] Brave search error: ${e.message}`);
    }
    await sleep(1150);
  }

  const records: any[] = [];
  for (const cand of candidates) {
    if (records.length >= MAX_FOUNDATIONS_NEW) break;

    const combinedMeta = normalizeText(`${cand.title} ${cand.snippet} ${cand.url}`);
    if (
      !combinedMeta.includes('2026') &&
      !combinedMeta.includes('2027')
    ) {
      stateSeenSet.add(cand.url);
      continue;
    }

    if (
      !combinedMeta.includes('edital') &&
      !combinedMeta.includes('chamada') &&
      !combinedMeta.includes('chamamento') &&
      !combinedMeta.includes('selecao') &&
      !combinedMeta.includes('fomento')
    ) {
      stateSeenSet.add(cand.url);
      continue;
    }

    // Avoid news articles / old reports without actual grant call signals
    if (combinedMeta.includes('/noticias/') && !combinedMeta.includes('inscri') && !cand.url.toLowerCase().endsWith('.pdf')) {
      stateSeenSet.add(cand.url);
      continue;
    }

    stateSeenSet.add(cand.url);

    let pdfLink: string | undefined;
    let pageText = `${cand.title}\n${cand.snippet}`;

    if (cand.url.toLowerCase().includes('.pdf') && (await isReachablePdf(cand.url))) {
      pdfLink = cand.url;
    } else {
      try {
        const pageRes = await fetch(cand.url, {
          headers: { 'User-Agent': 'TriadeMatchmaker/1.0' },
          signal: AbortSignal.timeout(9000)
        });
        if (pageRes.ok) {
          const ct = (pageRes.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('application/pdf')) {
            pdfLink = cand.url;
          } else if (ct.includes('text/html') || ct.includes('text/plain')) {
            const html = await pageRes.text();
            const extractedPdf = extractPdfLinkFromHtml(html, cand.url);
            if (extractedPdf && (await isReachablePdf(extractedPdf))) {
              pdfLink = extractedPdf;
            }
            const stripped = stripHtmlToText(html);
            if (stripped.length > 300) {
              pageText = `${cand.title}\nURL: ${cand.url}\n${stripped}`.slice(0, 14000);
            }
          }
        }
      } catch {
        // Keep snippet fallback if sufficient
      }
    }

    if (!pdfLink && pageText.length < 450) {
      continue;
    }

    const id = 'fund_' + crypto.createHash('sha1').update(cand.url).digest('hex').slice(0, 10);
    const sig = buildDedupSignature(cand.title || cand.url, null);
    if (seenIds.has(id) || seenSignatures.has(sig)) continue;

    seenIds.add(id);
    seenUrls.add(cand.url);
    seenSignatures.add(sig);

    let host = 'Fundação / Instituto';
    try {
      host = new URL(cand.url).hostname.replace(/^www\./, '');
    } catch {}

    records.push({
      id,
      source_portal: 'Fundações (Brave)',
      attributes: {
        nome: cand.title || `Edital ${host}`,
        patrocinador: host,
        locais: [{ abrangencia: 'Nacional' }],
        areas_interesse: ['Investimento Social Privado / Fundação']
      },
      public_url: cand.url,
      pdf_link: pdfLink,
      full_text: pageText,
      pipeline_status: 'PENDING_EXTRACTION'
    });
  }

  state.last_foundations_run_at = new Date().toISOString();
  state.seen_foundation_urls = Array.from(stateSeenSet).slice(-1000);

  return { records, ranSearch: true };
}

async function runExtraSourcesScraper() {
  const todayIso = new Date().toISOString().split('T')[0];

  let editais: any[] = [];
  try {
    editais = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
    if (!Array.isArray(editais)) editais = [];
  } catch {
    editais = [];
  }

  let historico: any[] = [];
  try {
    historico = JSON.parse(await fs.readFile(ARCHIVE_FILE, 'utf-8'));
    if (!Array.isArray(historico)) historico = [];
  } catch {
    historico = [];
  }

  let state: ExtraSourcesState = { seen_foundation_urls: [] };
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
    if (!Array.isArray(state.seen_foundation_urls)) state.seen_foundation_urls = [];
  } catch {
    state = { seen_foundation_urls: [] };
  }

  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const seenSignatures = new Set<string>();

  for (const item of [...editais, ...historico]) {
    if (!item) continue;
    if (item.id) seenIds.add(String(item.id));
    if (item.public_url) seenUrls.add(String(item.public_url));
    if (item.pdf_link) seenUrls.add(String(item.pdf_link));
    const nome = item.attributes?.nome;
    const dataFim = normalizeDateOnly(item.deep_metadata?.prazo_de_inscricao || item.attributes?.data_fim);
    if (nome) seenSignatures.add(buildDedupSignature(nome, dataFim));
  }

  console.log(`[ExtraSources] Starting scan (existing active: ${editais.length}, archived: ${historico.length})...`);

  const pncpRecords = await collectFromPncp(seenIds, seenUrls, seenSignatures, todayIso);
  console.log(`[ExtraSources][PNCP] Found ${pncpRecords.length} new MROSC/Chamamento editais.`);

  const mapasRecords = await collectFromMapasCulturais(seenIds, seenUrls, seenSignatures, todayIso);
  console.log(`[ExtraSources][Mapas] Found ${mapasRecords.length} new Mapas Culturais editais.`);

  const { records: foundationRecords, ranSearch } = await collectFromFoundationsBrave(seenIds, seenUrls, seenSignatures, state);
  console.log(`[ExtraSources][Foundations] Found ${foundationRecords.length} new Foundation editais (Brave ran: ${ranSearch}).`);

  const allNew = [...pncpRecords, ...mapasRecords, ...foundationRecords];
  if (allNew.length > 0) {
    const updated = [...allNew, ...editais];
    await fs.writeFile(DATA_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    console.log(`[ExtraSources] Saved ${allNew.length} new editais into ${DATA_FILE} (new total: ${updated.length}).`);
  } else {
    console.log(`[ExtraSources] No new extra-source editais found this run.`);
  }

  if (ranSearch) {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  }
}

runExtraSourcesScraper().catch(err => {
  console.error('[ExtraSources] Fatal error:', err);
  process.exit(1);
});
