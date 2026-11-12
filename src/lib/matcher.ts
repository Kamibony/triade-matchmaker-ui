function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function calculateMatches(editalDeepMetadata: any, ngosArray: any[]) {
  const { criterios_eliminatorios } = editalDeepMetadata;
  const {
    abrangencia_nacional,
    estados_permitidos,
    municipios_permitidos,
    idade_minima_cnpj_anos,
    natureza_juridica_excluida
  } = criterios_eliminatorios;

  return ngosArray.map(ngo => {
    let isEligible = true;
    let failedReason = '';

    // Rule 1 (National Coverage) & Rule 2 (Geography Matching)
    if (!abrangencia_nacional) {
      if (estados_permitidos && estados_permitidos.length > 0) {
        if (!ngo.uf) {
          isEligible = false;
          failedReason = 'Não atende restrição estadual (UF não informada)';
        } else {
          const ngoUf = normalizeText(ngo.uf);
          const hasStateMatch = estados_permitidos.some((e: string) => {
            const stateNorm = normalizeText(e);
            return stateNorm === ngoUf || stateNorm.includes(ngoUf) || ngoUf.includes(stateNorm);
          });
          if (!hasStateMatch) {
            isEligible = false;
            failedReason = 'Não atende restrição estadual';
          }
        }
      }

      if (isEligible && municipios_permitidos && municipios_permitidos.length > 0) {
        if (!ngo.municipio) {
          isEligible = false;
          failedReason = 'Não atende restrição municipal (Município não informado)';
        } else {
          const ngoMuni = normalizeText(ngo.municipio);
          const hasCityMatch = municipios_permitidos.some((m: string) => {
            const cityPart = normalizeText(m.split('-')[0].trim());
            return cityPart === ngoMuni || cityPart.includes(ngoMuni) || ngoMuni.includes(cityPart);
          });
          if (!hasCityMatch) {
            isEligible = false;
            failedReason = 'Não atende restrição municipal';
          }
        }
      }
    }

    // Rule 3 (Minimum CNPJ Age)
    if (isEligible && idade_minima_cnpj_anos !== null && idade_minima_cnpj_anos !== undefined) {
      if (ngo.idade_anos !== undefined && ngo.idade_anos < idade_minima_cnpj_anos) {
        isEligible = false;
        failedReason = 'Não atende restrição de idade mínima do CNPJ';
      }
    }

    // Rule 4 (Legal Nature Exclusions - properly handling Portuguese 'sem fins lucrativos' vs 'fins lucrativos')
    if (isEligible && Array.isArray(natureza_juridica_excluida) && natureza_juridica_excluida.length > 0) {
      const ngoNatNorm = normalizeText(ngo.natureza_juridica || 'associacao privada');
      const isNgo = ngoNatNorm.includes('associacao') || ngoNatNorm.includes('fundacao') || ngoNatNorm.includes('organizacao');

      const isExcluded = natureza_juridica_excluida.some((excluded: string) => {
        const exclNorm = normalizeText(excluded);

        // If the grant explicitly excludes non-profits or legal entities (e.g. individual-only grants)
        if (isNgo) {
          if (
            exclNorm.includes('sem fins lucrativos') ||
            exclNorm.includes('exclusivo para pessoa fisica') ||
            exclNorm.includes('pessoa juridica nao prevista') ||
            exclNorm === 'pessoa juridica'
          ) {
            return true;
          }
        }

        // Ignore generic 'fins lucrativos' exclusions for non-profit NGOs
        if (exclNorm.includes('fins lucrativos') && !exclNorm.includes('sem fins lucrativos')) {
          return false;
        }

        return exclNorm.includes(ngoNatNorm) || ngoNatNorm.includes(exclNorm);
      });

      if (isExcluded) {
        isEligible = false;
        failedReason = 'Natureza jurídica excluída pelo edital';
      }
    }

    return {
      ...ngo,
      eligibility: {
        isEligible,
        failedReason: failedReason || undefined
      }
    };
  });
}
