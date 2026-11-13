import fs from 'fs/promises';
import path from 'path';

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractHeaderInfoFromFullText(fullText: string | undefined): { data_fim?: string; valor_total?: number } {
  if (!fullText) return {};
  const info: { data_fim?: string; valor_total?: number } = {};
  const match2Digit = fullText.match(/(\d{2})\/(\d{2})\/(\d{2})\s+at[ée]\s+(\d{2})\/(\d{2})\/(\d{2})/i);
  if (match2Digit) {
    info.data_fim = `20${match2Digit[6]}-${match2Digit[5]}-${match2Digit[4]}`;
  } else {
    const match4Digit = fullText.match(/Inscri[çc][õo]es a partir de:\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{2}:\d{2})?\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    if (match4Digit) {
      info.data_fim = `${match4Digit[6]}-${match4Digit[5]}-${match4Digit[4]}`;
    }
  }
  const valMatch = fullText.match(/Total Dispon[íi]vel\s+R\$\s*([\d\.]+,\d{2})/i);
  if (valMatch) {
    const parsedVal = parseFloat(valMatch[1].replace(/\./g, '').replace(',', '.'));
    if (!isNaN(parsedVal) && parsedVal > 0) {
      info.valor_total = parsedVal;
    }
  }
  return info;
}

function isEditalSuitableForNgos(edital: any): boolean {
  const nomeNorm = normalizeText(edital.attributes?.nome || '');
  const resumoNorm = normalizeText(edital.deep_metadata?.resumo_objetivo || '');

  const nonNgoPatterns = [
    'bolsa ', 'bolsas ', 'pos-graduacao', 'mestrado', 'doutorado', 'iniciacao cientifica', 'pibex',
    'produtividade em pesquisa', 'catedra', 'subvencao economica',
    'inovacao para a industria'
  ];
  if (nonNgoPatterns.some(p => nomeNorm.includes(p))) {
    return false;
  }

  const exclList: string[] = edital.deep_metadata?.criterios_eliminatorios?.natureza_juridica_excluida || [];
  const forbidsNonProfits = exclList.some(item => {
    const norm = normalizeText(item);
    return (
      norm.includes('sem fins lucrativos') ||
      norm.includes('exclusivo para pessoa fisica') ||
      norm.includes('pessoa juridica nao prevista') ||
      norm === 'pessoa juridica'
    );
  });

  if (forbidsNonProfits) return false;
  if (resumoNorm.includes('exclusivamente para pessoas fisicas')) return false;

  return true;
}

export async function load() {
  const leadsPath = path.join(process.cwd(), 'src', 'data', 'daily_outbound_leads.json');
  const editaisPath = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');

  let leads: any[] = [];
  let bancoEditais: any[] = [];
  const editalMap = new Map<string, any>();

  try {
    const editaisRaw = await fs.readFile(editaisPath, 'utf-8');
    const allEditais = JSON.parse(editaisRaw);
    const now = new Date();
    const todayIso = now.toISOString().split('T')[0];

    for (const e of allEditais) {
      if (!e.deep_metadata) continue;
      const headerInfo = extractHeaderInfoFromFullText(e.full_text);
      const prazo = headerInfo.data_fim || e.deep_metadata.prazo_de_inscricao || e.attributes?.data_fim || null;
      let diasRestantes: number | null = null;

      if (prazo && prazo !== 'Não informado') {
        if (prazo < todayIso) continue;
        const diffMs = new Date(prazo + 'T23:59:59').getTime() - now.getTime();
        diasRestantes = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      }

      const rawVal = e.deep_metadata.financeiro?.valor_maximo_ou_global_reais;
      const valor = (rawVal && rawVal >= 100 ? rawVal : null) || headerInfo.valor_total || e.attributes?.valor_total || null;
      const ufs = e.deep_metadata.criterios_eliminatorios?.estados_permitidos || [];
      const municipios = e.deep_metadata.criterios_eliminatorios?.municipios_permitidos || [];
      const nacional = !!e.deep_metadata.criterios_eliminatorios?.abrangencia_nacional;

      const summaryObj = {
        id: String(e.id),
        titulo: e.attributes?.nome || `Edital ${e.id}`,
        valor,
        prazo,
        dias_restantes: diasRestantes,
        abrangencia_nacional: nacional,
        estados_permitidos: ufs,
        municipios_permitidos: municipios,
        temas_principais: e.deep_metadata.temas_principais || [],
        resumo_objetivo: e.deep_metadata.resumo_objetivo || '',
        url: e.deep_metadata.drive_pdf_link || e.pdf_link || e.public_url || null
      };

      editalMap.set(String(e.id), summaryObj);

      if (isEditalSuitableForNgos(e)) {
        bancoEditais.push(summaryObj);
      }
    }

    bancoEditais.sort((a, b) => (b.valor || 0) - (a.valor || 0));
  } catch (err) {
    console.warn('Could not load editais_prosas.json in /outbound:', err);
  }

  try {
    const data = await fs.readFile(leadsPath, 'utf-8');
    const rawLeads = JSON.parse(data);
    const todayIso = new Date().toISOString().split('T')[0];

    leads = (Array.isArray(rawLeads) ? rawLeads : [])
      .map(lead => {
        // Hard guard: never let legacy failed or 0-score leads reach the UI
        const score = Number(lead?.score) || 0;
        const motivo = (lead?.motivo_match || '').trim().toLowerCase();
        const msg = (lead?.whatsapp_message || '').trim().toLowerCase();
        if (score <= 0 || motivo === 'failed' || msg.includes('outreach message failed')) {
          return null;
        }

        const meta = editalMap.get(String(lead.edital_id));
        const prazo = meta?.prazo || lead.edital_prazo || null;
        if (prazo && prazo !== 'Não informado' && prazo < todayIso) {
          return null;
        }
        return {
          ...lead,
          edital_valor: meta?.valor || lead.edital_valor || null,
          edital_prazo: prazo,
          dias_restantes: meta?.dias_restantes ?? null,
          edital_ufs: meta?.estados_permitidos || []
        };
      })
      .filter(Boolean);
  } catch {
    leads = [];
  }

  return { leads, bancoEditais };
}
