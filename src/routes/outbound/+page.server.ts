import fs from 'fs/promises';
import path from 'path';

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isEditalSuitableForNgos(edital: any): boolean {
  const nomeNorm = normalizeText(edital.attributes?.nome || '');
  const resumoNorm = normalizeText(edital.deep_metadata?.resumo_objetivo || '');

  const nonNgoPatterns = [
    'bolsa ', 'bolsas ', 'pos-graduacao', 'iniciacao cientifica', 'pibex',
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
      const prazo = e.deep_metadata.prazo_de_inscricao || e.attributes?.data_fim || null;
      let diasRestantes: number | null = null;

      if (prazo && prazo !== 'Não informado') {
        if (prazo < todayIso) continue; // Skip expired editais completely
        const diffMs = new Date(prazo + 'T23:59:59').getTime() - now.getTime();
        diasRestantes = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      }

      const valor = e.deep_metadata.financeiro?.valor_maximo_ou_global_reais || e.attributes?.valor_total || null;
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

    // Sort Banco de Editais by value descending
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
        const meta = editalMap.get(String(lead.edital_id));
        const prazo = meta?.prazo || lead.edital_prazo || null;
        if (prazo && prazo !== 'Não informado' && prazo < todayIso) {
          return null; // Hide leads for expired editais
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
