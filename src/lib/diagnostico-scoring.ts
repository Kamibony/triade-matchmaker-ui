export type EstatutoStatus = 'sim' | 'atualizar' | 'nao';
export type AtaStatus = 'vigente_6m' | 'vence_breve' | 'vencida';
export type CndStatus = 'em_dia' | 'regularizando' | 'nao_sei';
export type CaucCepimStatus = 'em_dia' | 'regularizando' | 'pendencia_ou_nao_sei';
export type BalancoStatus = 'sim_2anos' | 'parcial_1ano' | 'nao';
export type PorteOrcamento = 'ate_100k' | '100k_500k' | '500k_2m' | 'acima_2m';
export type ExperienciaStatus = 'executou' | 'submeteu' | 'primeira_vez';
export type TierClass = 'Tier A' | 'Tier B' | 'Tier C';

export const LGPD_CONSENT_VERSION = 'LGPD_v1_2026-11-23';
export const LGPD_CONTROLLER_NAME = 'Tríade Captação de Recursos';
export const LGPD_PRIVACY_EMAIL = 'triade.captacaoderecursos@gmail.com';
export const LGPD_CONSENT_TEXT =
  'Autorizo a Tríade Captação de Recursos (controladora dos dados) a armazenar as informações deste formulário para gerar meu diagnóstico documental e avisar sobre editais compatíveis, podendo solicitar exclusão a qualquer momento pelo e-mail triade.captacaoderecursos@gmail.com.';

export const AREAS_ATUACAO_OPTIONS = [
  { id: 'mulheres', label: 'Mulheres e Equidade de Gênero', keywords: ['mulher', 'mulheres', 'genero', 'equidade', 'feminino'] },
  { id: 'agro', label: 'Agricultura Familiar / Agroecologia', keywords: ['agricultura', 'familiar', 'agroecologia', 'rural', 'alimentos', 'cooperativa', 'agro'] },
  { id: 'assistencia', label: 'Assistência Social / Idosos / PCD', keywords: ['assistencia', 'social', 'idoso', 'idosos', 'pcd', 'deficiencia', 'vulnerabilidade', 'suas'] },
  { id: 'educacao', label: 'Educação / Juventude', keywords: ['educacao', 'juventude', 'jovens', 'crianca', 'adolescente', 'escola', 'capacitacao'] },
  { id: 'saude', label: 'Saúde / Hospitais Filantrópicos', keywords: ['saude', 'hospital', 'filantropico', 'cuidado', 'atendimento'] },
  { id: 'meio_ambiente', label: 'Meio Ambiente / Clima', keywords: ['meio', 'ambiente', 'ambiental', 'clima', 'floresta', 'agua', 'sustentabilidade', 'residuos'] },
  { id: 'cultura_esporte', label: 'Cultura / Esporte', keywords: ['cultura', 'cultural', 'arte', 'esporte', 'patrimonio', 'musica'] },
  { id: 'direitos_humanos', label: 'Direitos Humanos / Povos Tradicionais', keywords: ['direitos', 'humanos', 'quilombola', 'indigena', 'tradicionais', 'cidadania', 'racial'] },
  { id: 'geracao_renda', label: 'Geração de Renda / Economia Solidária', keywords: ['renda', 'economia', 'solidaria', 'empreendedorismo', 'trabalho', 'produtivo', 'artesanato'] }
] as const;

export const SELOS_OPTIONS = [
  { id: 'cebas', label: 'CEBAS vigente' },
  { id: 'conselhos', label: 'Inscrição em Conselhos (CMAS / CMDCA / outros)' },
  { id: 'caf_dap', label: 'CAF / DAP / Agricultura Familiar' },
  { id: 'utilidade_publica', label: 'Utilidade Pública ou OSCIP' }
] as const;

export interface DiagnosticoInput {
  idade_cnpj_anos: number;
  estatuto: EstatutoStatus;
  ata: AtaStatus;
  cnd: CndStatus;
  cauc_cepim: CaucCepimStatus;
  balanco: BalancoStatus;
  porte_orcamento: PorteOrcamento;
  experiencia: ExperienciaStatus;
  conta_pj_ativa: boolean;
  selos: string[];
}

export interface DiagnosticoPendencia {
  item: string;
  prioridade: 'Alta' | 'Média';
  detalhe: string;
}

export interface DiagnosticoResult {
  score: number;
  tier: TierClass;
  tierLabel: string;
  tierDescription: string;
  travasPendentes: string[];
  pontosFortes: string[];
  pendencias: DiagnosticoPendencia[];
  breakdown: {
    idadeCnpj: number;
    estatuto: number;
    ata: number;
    cnd: number;
    caucCepim: number;
    balanco: number;
    experiencia: number;
    contaPj: number;
    selos: number;
  };
}

/**
 * Calcula o Índice de Prontidão (0 a 100) e classificação Tier A / B / C.
 * Orçamento anual é mantido apenas como filtro de porte (0 pts) para não penalizar
 * associações comunitárias, rurais e de base abaixo de R$ 100 mil/ano.
 */
export function evaluateDiagnostico(input: DiagnosticoInput): DiagnosticoResult {
  const idade = Number.isFinite(input.idade_cnpj_anos) ? Math.max(0, input.idade_cnpj_anos) : 0;

  const idadeCnpj = idade >= 3 ? 15 : idade >= 2 ? 10 : idade >= 1 ? 4 : 0;
  const estatuto = input.estatuto === 'sim' ? 10 : input.estatuto === 'atualizar' ? 4 : 0;
  const ata = input.ata === 'vigente_6m' ? 15 : input.ata === 'vence_breve' ? 8 : 0;
  const cnd = input.cnd === 'em_dia' ? 20 : input.cnd === 'regularizando' ? 5 : 0;
  const caucCepim = input.cauc_cepim === 'em_dia' ? 10 : input.cauc_cepim === 'regularizando' ? 3 : 0;
  const balanco = input.balanco === 'sim_2anos' ? 10 : input.balanco === 'parcial_1ano' ? 5 : 0;
  const experiencia = input.experiencia === 'executou' ? 10 : input.experiencia === 'submeteu' ? 4 : 1;
  const contaPj = input.conta_pj_ativa ? 5 : 0;

  const validSelosCount = Array.isArray(input.selos) ? new Set(input.selos.filter(Boolean)).size : 0;
  const selos = Math.min(5, validSelosCount * 2);

  const score = Math.min(
    100,
    idadeCnpj + estatuto + ata + cnd + caucCepim + balanco + experiencia + contaPj + selos
  );

  // 5 travas obrigatórias do Tier A (Balanço/DRE e Experiência pontuam mas NÃO travam o Tier A)
  const travasPendentes: string[] = [];
  if (idade < 2) travasPendentes.push('CNPJ com menos de 2 anos de constituição');
  if (input.estatuto !== 'sim') travasPendentes.push('Estatuto Social registrado e atualizado');
  if (input.ata === 'vencida') travasPendentes.push('Ata de Eleição da Diretoria vigente');
  if (input.cnd !== 'em_dia') travasPendentes.push('Certidões Negativas (CND Federal, FGTS e Trabalhista) em dia');
  if (input.cauc_cepim !== 'em_dia') travasPendentes.push('Adimplência no CAUC / CEPIM / Transferegov (art. 39 MROSC)');

  let tier: TierClass;
  let tierLabel: string;
  let tierDescription: string;

  if (score >= 80 && travasPendentes.length === 0) {
    tier = 'Tier A';
    tierLabel = 'Pronta para Captar';
    tierDescription =
      'Sua organização reúne a base jurídica, fiscal e documental exigida pela maioria dos editais públicos e privados abertos hoje.';
  } else if (score >= 50) {
    tier = 'Tier B';
    tierLabel = 'Quase Pronta';
    tierDescription =
      travasPendentes.length > 0
        ? 'Você já tem uma boa estrutura, mas resolver as pendências documentais abaixo é essencial antes de protocolar em editais maiores.'
        : 'Sua organização está próxima do nível ideal. Reforçar os itens de gestão abaixo ampliará bastante sua pontuação nos editais.';
  } else {
    tier = 'Tier C';
    tierLabel = 'Em Estruturação';
    tierDescription =
      'Recomendamos focar primeiro na regularização documental básica (estatuto, ata, certidões e CAUC/CEPIM) e em chamadas locais de menor porte.';
  }

  const pontosFortes: string[] = [];
  if (idade >= 3) pontosFortes.push(`CNPJ consolidado (${Math.floor(idade)} anos de atuação)`);
  else if (idade >= 2) pontosFortes.push('CNPJ atende ao mínimo de 2 anos da maioria dos editais');
  if (input.estatuto === 'sim') pontosFortes.push('Estatuto Social registrado e atualizado em cartório');
  if (input.ata === 'vigente_6m') pontosFortes.push('Ata da Diretoria vigente com boa margem de mandato');
  if (input.cnd === 'em_dia') pontosFortes.push('Certidões Negativas (CND Federal, FGTS e Trabalhista) em dia');
  if (input.cauc_cepim === 'em_dia') pontosFortes.push('Situação adimplente no CAUC / CEPIM / Transferegov');
  if (input.balanco === 'sim_2anos') pontosFortes.push('Balanço e DRE dos últimos 2 anos assinados por contador');
  if (input.experiencia === 'executou') pontosFortes.push('Experiência prévia comprovada com execução e prestação de contas');
  if (input.conta_pj_ativa) pontosFortes.push('Conta bancária PJ ativa em nome da organização');
  if (validSelosCount > 0) pontosFortes.push('Possui selos/conselhos que ampliam elegibilidade em editais específicos');

  const pendencias: DiagnosticoPendencia[] = [];
  if (input.cnd !== 'em_dia') {
    pendencias.push({
      item: 'Emitir/regularizar Certidões Negativas (CND Federal, FGTS e CNDT)',
      prioridade: 'Alta',
      detalhe: 'Critério eliminatório em praticamente 100% dos editais públicos e fundos privados.'
    });
  }
  if (input.cauc_cepim !== 'em_dia') {
    pendencias.push({
      item: 'Conferir adimplência no CEPIM / CAUC / Transferegov',
      prioridade: 'Alta',
      detalhe: 'Impedimento previsto no art. 39 da Lei 13.019/2014 (MROSC) para termos de fomento e convênios federais.'
    });
  }
  if (input.ata === 'vencida') {
    pendencias.push({
      item: 'Realizar assembleia e registrar nova Ata da Diretoria em cartório',
      prioridade: 'Alta',
      detalhe: 'Diretoria com mandato vencido impede a assinatura de contratos e termos de fomento.'
    });
  } else if (input.ata === 'vence_breve') {
    pendencias.push({
      item: 'Programar renovação da Ata da Diretoria antes do vencimento',
      prioridade: 'Média',
      detalhe: 'Editais com trâmite longo podem exigir mandato vigente na data da contratação.'
    });
  }
  if (input.estatuto !== 'sim') {
    pendencias.push({
      item: 'Atualizar e registrar o Estatuto Social em cartório',
      prioridade: 'Alta',
      detalhe: 'Garanta que o objeto social e as cláusulas do art. 33 do MROSC estejam atualizados.'
    });
  }
  if (input.balanco !== 'sim_2anos') {
    pendencias.push({
      item: 'Organizar Balanço Patrimonial e DRE dos últimos 2 anos com contador',
      prioridade: 'Média',
      detalhe: 'Exigido por grandes financiadores (BNDES, fundações empresariais e chamadas estruturantes).'
    });
  }
  if (!input.conta_pj_ativa) {
    pendencias.push({
      item: 'Regularizar conta bancária PJ em nome do CNPJ da OSC',
      prioridade: 'Média',
      detalhe: 'Obrigatória para recebimento de recursos sem repasse a contas de pessoa física.'
    });
  }
  if (idade < 2) {
    pendencias.push({
      item: 'Acompanhar editais sem exigência de 2 anos de CNPJ (ou atuar em rede)',
      prioridade: 'Média',
      detalhe: 'Enquanto o CNPJ completa 2–3 anos, foque em chamadas locais ou parcerias com entidades âncora.'
    });
  }

  return {
    score,
    tier,
    tierLabel,
    tierDescription,
    travasPendentes,
    pontosFortes,
    pendencias,
    breakdown: {
      idadeCnpj,
      estatuto,
      ata,
      cnd,
      caucCepim,
      balanco,
      experiencia,
      contaPj,
      selos
    }
  };
}
