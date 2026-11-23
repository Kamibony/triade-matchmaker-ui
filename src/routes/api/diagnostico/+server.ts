import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { google } from 'googleapis';
import type { RequestHandler } from './$types';
import { calculateMatches } from '../../../lib/matcher';
import editaisData from '../../../data/editais_prosas.json';
import {
  AREAS_ATUACAO_OPTIONS,
  LGPD_CONSENT_VERSION,
  evaluateDiagnostico,
  type AtaStatus,
  type BalancoStatus,
  type CaucCepimStatus,
  type CndStatus,
  type EstatutoStatus,
  type ExperienciaStatus,
  type PorteOrcamento
} from '../../../lib/diagnostico-scoring';

const DEFAULT_OSC_DIAGNOSTICO_SHEET_ID = '1pmzsT6MIkiLfoHCRyosWNs6PH5dKEV3ibMgJMod7ZOg';

const PORTUGUESE_STOPWORDS = new Set([
  'associacao', 'associacoes', 'direitos', 'sociais', 'social', 'atividades',
  'organizacoes', 'organizacao', 'defesa', 'desenvolvimento', 'projeto', 'projetos',
  'apoio', 'brasil', 'nacional', 'estadual', 'municipal', 'publico', 'publica',
  'selecao', 'chamamento', 'edital', 'fomento', 'recursos', 'execucao', 'acoes',
  'atraves', 'meio', 'forma', 'valor', 'instituicoes', 'entidades', 'civil',
  'sociedade', 'servicos', 'outros', 'outras', 'especificados', 'anteriormente',
  'ligadas', 'privada', 'fundacao', 'instituto', 'comunitario', 'comunitaria'
]);

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatBrasiliaTimestamp(now = new Date()): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);
}

function formatBrasiliaDate(now = new Date()): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function getGoogleAuth() {
  const credsEnv = (env.GCP_DRIVE_CREDENTIALS || process.env.GCP_DRIVE_CREDENTIALS || '').trim();
  if (!credsEnv) return null;

  const credentials = JSON.parse(credsEnv);
  if (credentials.refreshToken && credentials.clientId && credentials.clientSecret) {
    const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    auth.setCredentials({ refresh_token: credentials.refreshToken });
    return auth;
  }

  if (credentials.private_key && credentials.client_email) {
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }

  return null;
}

function isEditalSuitableForNgos(edital: any): boolean {
  const nomeNorm = normalizeText(edital.attributes?.nome || '');
  const resumoNorm = normalizeText(edital.deep_metadata?.resumo_objetivo || '');

  const nonNgoPatterns = [
    'bolsa ', 'bolsas ', 'pos-graduacao', 'iniciacao cientifica', 'pibex',
    'produtividade em pesquisa', 'catedra', 'subvencao economica',
    'inovacao para a industria', 'eficiencia energetica', 'pee/aneel',
    'cpp 001/', 'cpp 002/'
  ];
  if (nonNgoPatterns.some((p) => nomeNorm.includes(p))) return false;
  if (resumoNorm.includes('exclusivamente para pessoas fisicas') || resumoNorm.includes('empresas juniores')) {
    return false;
  }
  return true;
}

function findTop3OpenEditais(params: {
  cnpj: string;
  nome: string;
  uf: string;
  municipio: string;
  natureza_juridica: string;
  idade_anos: number;
  cnae_principal: string;
  areas: string[];
  necessidade_principal: string;
}) {
  const now = new Date();
  now.setDate(now.getDate() + 5);
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const threshold = `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}-${parts.find((p) => p.type === 'day')?.value}`;

  const areaKeywords = params.areas.flatMap((id) => {
    const found = AREAS_ATUACAO_OPTIONS.find((a) => a.id === id);
    return found ? [...found.keywords, normalizeText(found.label)] : [normalizeText(id)];
  });

  const oscProfile: any = {
    cnpj: params.cnpj,
    nome: params.nome,
    uf: params.uf,
    municipio: params.municipio,
    natureza_juridica: params.natureza_juridica,
    idade_anos: params.idade_anos,
    foco_atividades: `${areaKeywords.join(' ')} ${params.necessidade_principal} ${params.cnae_principal}`
  };

  const contextTokens = [
    ...new Set(
      normalizeText(`${params.nome} ${areaKeywords.join(' ')} ${params.necessidade_principal} ${params.cnae_principal}`)
        .split(/[\s,.;:()/-]+/)
        .filter((w) => w.length > 3 && !PORTUGUESE_STOPWORDS.has(w))
    )
  ];

  const ranked: Array<{ edital: any; score: number; prazo: string; valor: number | null; nacional: boolean }> = [];

  for (const edital of editaisData as any[]) {
    if (!edital?.deep_metadata?.criterios_eliminatorios) continue;
    if (!isEditalSuitableForNgos(edital)) continue;

    const prazo = String(
      edital.deep_metadata.prazo_de_inscricao || edital.attributes?.data_fim || ''
    ).trim();
    if (prazo && prazo.toLowerCase() !== 'não informado' && /^\d{4}-\d{2}-\d{2}/.test(prazo)) {
      if (prazo.slice(0, 10) < threshold) continue;
    }

    const matchResult = calculateMatches(edital.deep_metadata, [oscProfile]);
    if (!matchResult.length || !matchResult[0].eligibility.isEligible) continue;

    const temasNorm = normalizeText((edital.deep_metadata.temas_principais || []).join(' '));
    const resumoNorm = normalizeText(`${edital.attributes?.nome || ''} ${edital.deep_metadata.resumo_objetivo || ''}`);
    const nacional = !!edital.deep_metadata.criterios_eliminatorios.abrangencia_nacional;

    let score = nacional ? 10 : 35; // Regional grants have lower competition
    for (const token of contextTokens) {
      if (temasNorm.includes(token)) score += 30;
      else if (resumoNorm.includes(token)) score += 12;
    }

    const rawValor = edital.deep_metadata.financeiro?.valor_maximo_ou_global_reais;
    const valor =
      rawValor && rawValor >= 100
        ? Number(rawValor)
        : edital.attributes?.valor_total
          ? Number(edital.attributes.valor_total)
          : null;

    ranked.push({
      edital,
      score,
      prazo: prazo || 'Fluxo contínuo / verificar edital',
      valor,
      nacional
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.valor || 0) - (a.valor || 0);
  });

  return ranked.slice(0, 3).map((item) => ({
    edital_id: String(item.edital.id),
    titulo: item.edital.attributes?.nome || String(item.edital.id),
    resumo: String(item.edital.deep_metadata?.resumo_objetivo || '').slice(0, 220),
    prazo: item.prazo,
    valor_maximo_reais: item.valor,
    abrangencia: item.nacional ? 'Nacional' : `Regional (${params.uf || 'UF específica'})`,
    url: item.edital.attributes?.link_edital || item.edital.pdf_link || null
  }));
}

const LABELS = {
  estatuto: {
    sim: 'Sim, registrado e atualizado',
    atualizar: 'Registrado, precisa atualizar',
    nao: 'Não possui / em formação'
  },
  ata: {
    vigente_6m: 'Vigente (> 6 meses)',
    vence_breve: 'Vigente (vence em <= 6 meses)',
    vencida: 'Vencida / sem ata'
  },
  cnd: {
    em_dia: 'Todas em dia',
    regularizando: 'Pendência em regularização',
    nao_sei: 'Vencidas / não sei'
  },
  cauc_cepim: {
    em_dia: 'Em dia / Adimplente',
    regularizando: 'Pendência em regularização',
    pendencia_ou_nao_sei: 'Com pendência / não sei'
  },
  balanco: {
    sim_2anos: 'Sim (últimos 2 anos)',
    parcial_1ano: 'Parcial / 1 ano',
    nao: 'Não possui'
  },
  porte: {
    ate_100k: 'Até R$ 100 mil/ano',
    '100k_500k': 'R$ 100 mil a R$ 500 mil/ano',
    '500k_2m': 'R$ 500 mil a R$ 2 milhões/ano',
    acima_2m: 'Acima de R$ 2 milhões/ano'
  },
  experiencia: {
    executou: 'Já executou e prestou contas',
    submeteu: 'Já submeteu sem aprovação',
    primeira_vez: 'Primeira vez em editais'
  }
} as const;

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();

    const cnpjClean = String(body.cnpj || '').replace(/\D/g, '');
    if (cnpjClean.length !== 14) {
      return json({ error: 'Informe um CNPJ válido com 14 dígitos.' }, { status: 400 });
    }
    if (!body.opt_in_lgpd) {
      return json({ error: 'É necessário confirmar o consentimento LGPD para gerar o diagnóstico.' }, { status: 400 });
    }
    const contatoNome = String(body.contato_nome || '').trim();
    const contatoWhatsapp = String(body.contato_whatsapp || '').trim();
    const contatoEmail = String(body.contato_email || '').trim();
    if (!contatoNome || (!contatoWhatsapp && !contatoEmail)) {
      return json({ error: 'Informe seu nome e pelo menos um canal de contato (WhatsApp ou e-mail).' }, { status: 400 });
    }

    const areas: string[] = Array.isArray(body.areas) ? body.areas.map(String).filter(Boolean) : [];
    const selos: string[] = Array.isArray(body.selos) ? body.selos.map(String).filter(Boolean) : [];
    const idadeAnos = Number(body.idade_cnpj_anos || 0);

    const estatuto = (body.estatuto || 'nao') as EstatutoStatus;
    const ata = (body.ata || 'vencida') as AtaStatus;
    const cnd = (body.cnd || 'nao_sei') as CndStatus;
    const caucCepim = (body.cauc_cepim || 'pendencia_ou_nao_sei') as CaucCepimStatus;
    const balanco = (body.balanco || 'nao') as BalancoStatus;
    const porteOrcamento = (body.porte_orcamento || 'ate_100k') as PorteOrcamento;
    const experiencia = (body.experiencia || 'primeira_vez') as ExperienciaStatus;
    const contaPjAtiva = Boolean(body.conta_pj_ativa);

    const evaluation = evaluateDiagnostico({
      idade_cnpj_anos: idadeAnos,
      estatuto,
      ata,
      cnd,
      cauc_cepim: caucCepim,
      balanco,
      porte_orcamento: porteOrcamento,
      experiencia,
      conta_pj_ativa: contaPjAtiva,
      selos
    });

    const razaoSocial = String(body.razao_social || '').trim();
    const uf = String(body.uf || '').trim().toUpperCase().slice(0, 2);
    const municipio = String(body.municipio || '').trim();
    const naturezaJuridica = String(body.natureza_juridica || '').trim();
    const cnaePrincipal = String(body.cnae_principal || '').trim();
    const necessidadePrincipal = String(body.necessidade_principal || '').trim().slice(0, 400);

    const topEditais = findTop3OpenEditais({
      cnpj: cnpjClean,
      nome: razaoSocial,
      uf,
      municipio,
      natureza_juridica: naturezaJuridica,
      idade_anos: idadeAnos,
      cnae_principal: cnaePrincipal,
      areas,
      necessidade_principal: necessidadePrincipal
    });

    const now = new Date();
    const timestampBrt = formatBrasiliaTimestamp(now);
    const dateBrt = formatBrasiliaDate(now);
    const formattedCnpj = cnpjClean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

    const areaLabels = areas
      .map((id) => AREAS_ATUACAO_OPTIONS.find((a) => a.id === id)?.label || id)
      .join(' | ');
    const editaisSummary = topEditais.map((e) => `${e.titulo} (prazo: ${e.prazo})`).join(' ; ');

    const origemRaw = String(body.origem_contato || 'Organico').trim();
    const origemValid = ['Lista', 'Indicacao', 'Organico'].includes(origemRaw) ? origemRaw : 'Organico';
    const campanhaTag = String(body.campanha_tag || '').trim().slice(0, 80);

    const rowValues = [
      timestampBrt, // A: Data_Hora_BRT
      formattedCnpj, // B: CNPJ
      razaoSocial, // C: Razao_Social
      uf, // D: UF
      municipio, // E: Municipio
      Math.floor(idadeAnos), // F: Idade_CNPJ_Anos
      naturezaJuridica, // G: Natureza_Juridica
      cnaePrincipal, // H: CNAE_Principal
      contatoNome, // I: Contato_Nome
      String(body.contato_cargo || '').trim(), // J: Contato_Cargo
      contatoWhatsapp, // K: Contato_WhatsApp
      contatoEmail, // L: Contato_Email
      areaLabels, // M: Areas_Atuacao_Tags
      LABELS.estatuto[estatuto] || estatuto, // N: Estatuto_Registrado
      LABELS.ata[ata] || ata, // O: Ata_Diretoria_Vigencia
      LABELS.cnd[cnd] || cnd, // P: CND_Status
      LABELS.cauc_cepim[caucCepim] || caucCepim, // Q: Situacao_CAUC_CEPIM
      LABELS.balanco[balanco] || balanco, // R: Balanco_DRE_2Anos
      LABELS.porte[porteOrcamento] || porteOrcamento, // S: Porte_Orcamento_Anual
      selos.join(', ') || 'Nenhum informado', // T: Certificacoes_Conselhos
      LABELS.experiencia[experiencia] || experiencia, // U: Experiencia_Editais
      contaPjAtiva ? 'Sim' : 'Não', // V: Conta_PJ_Ativa
      necessidadePrincipal, // W: Necessidade_Principal
      evaluation.score, // X: Score_Prontidao_0_100
      evaluation.tier, // Y: Tier
      editaisSummary || 'Nenhum edital aberto elegível no momento', // Z: Top3_Editais_Sugeridos
      dateBrt, // AA: Edital_Sugerido_Data
      'Sim', // AB: OptIn_LGPD
      `${timestampBrt} | ${LGPD_CONSENT_VERSION}`, // AC: LGPD_Data_Texto_Versao
      origemValid, // AD: Origem_Contato
      campanhaTag, // AE: Campanha_Tag
      '', // AF: Captador_Responsavel
      '', // AG: Conflito_Parceiros_Lusmar_Somax
      '', // AH: ID_CaptaHub
      'Novo', // AI: Status_Consultor
      evaluation.travasPendentes.length > 0
        ? `Travas pendentes: ${evaluation.travasPendentes.join('; ')}`
        : 'Sem travas documentais pendentes' // AJ: Notas_Claude_Equipe
    ];

    let savedToSheet = false;
    let sheetNote: string | undefined;

    console.log(
      JSON.stringify({
        source: 'osc-autodiagnostico',
        timestampBrt,
        cnpj: formattedCnpj,
        uf,
        score: evaluation.score,
        tier: evaluation.tier,
        editaisCount: topEditais.length
      })
    );

    try {
      const auth = getGoogleAuth();
      if (auth) {
        const spreadsheetId =
          (env.OSC_DIAGNOSTICO_SHEET_ID || process.env.OSC_DIAGNOSTICO_SHEET_ID || '').trim() ||
          DEFAULT_OSC_DIAGNOSTICO_SHEET_ID;
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: 'OSCs_Qualificadas!A:AJ',
          valueInputOption: 'RAW',
          requestBody: {
            values: [rowValues]
          }
        });
        savedToSheet = true;
      } else {
        sheetNote = 'Modo preview (GCP_DRIVE_CREDENTIALS não configurada localmente).';
      }
    } catch (sheetErr: any) {
      console.error('Erro ao gravar autodiagnostico no Google Sheets:', sheetErr?.message || sheetErr);
      sheetNote = 'Diagnóstico gerado com sucesso; gravação em nuvem será sincronizada posteriormente.';
    }

    return json({
      ok: true,
      savedToSheet,
      sheetNote,
      cnpj: formattedCnpj,
      razaoSocial,
      uf,
      municipio,
      evaluation,
      topEditais
    });
  } catch (err: any) {
    console.error('Erro em /api/diagnostico:', err);
    return json({ error: err?.message || 'Erro interno ao processar o autodiagnóstico.' }, { status: 500 });
  }
};
