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

    // Rule 1 (National Coverage) & Rule 2 (String Matching)
    // If abrangencia_nacional is true, skip geography checks.
    if (!abrangencia_nacional) {
      if (estados_permitidos && estados_permitidos.length > 0) {
        if (!ngo.uf) {
          isEligible = false;
          failedReason = 'Não atende restrição estadual (UF não informada)';
        } else {
          const hasStateMatch = estados_permitidos.some((e: string) =>
            e.toLowerCase().includes(ngo.uf.toLowerCase()) ||
            ngo.uf.toLowerCase().includes(e.toLowerCase())
          );
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
          const hasCityMatch = municipios_permitidos.some((m: string) =>
            m.toLowerCase().includes(ngo.municipio.toLowerCase()) ||
            ngo.municipio.toLowerCase().includes(m.toLowerCase())
          );
          if (!hasCityMatch) {
            isEligible = false;
            failedReason = 'Não atende restrição municipal';
          }
        }
      }
    }

    // Rule 3 (Missing K.O. Rules)
    if (isEligible && idade_minima_cnpj_anos !== null && idade_minima_cnpj_anos !== undefined) {
      if (ngo.idade_anos !== undefined && ngo.idade_anos < idade_minima_cnpj_anos) {
        isEligible = false;
        failedReason = 'Não atende restrição de idade mínima do CNPJ';
      }
    }

    if (isEligible && natureza_juridica_excluida && natureza_juridica_excluida.length > 0) {
      if (ngo.natureza_juridica) {
        const isExcluded = natureza_juridica_excluida.some((excluded: string) =>
          excluded.toLowerCase().includes(ngo.natureza_juridica.toLowerCase()) ||
          ngo.natureza_juridica.toLowerCase().includes(excluded.toLowerCase())
        );
        if (isExcluded) {
          isEligible = false;
          failedReason = 'Natureza jurídica excluída pelo edital';
        }
      }
    }

    // Rule 4 (Remove Themes): Thematic matching removed from Phase 1.

    return {
      ...ngo,
      eligibility: {
        isEligible,
        failedReason: failedReason || undefined
      }
    };
  });
}
