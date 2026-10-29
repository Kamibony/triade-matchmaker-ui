export function calculateMatches(editalDeepMetadata: any, ngosArray: any[]) {
  const { criterios_eliminatorios, temas_principais } = editalDeepMetadata;
  const { estados_permitidos, municipios_permitidos } = criterios_eliminatorios;

  return ngosArray.map(ngo => {
    let isEligible = true;
    let failedReason = '';
    let score = 0;

    // Rule A (Geography - estados_permitidos):
    // If the edital's estados_permitidos array has items, and the NGO is from Paraíba ("PB")
    // but "PB" is NOT in the array, the NGO fails.
    // (Assume all current NGOs in oscsData are from "PB" if not specified).
    if (estados_permitidos && estados_permitidos.length > 0) {
      if (!estados_permitidos.includes('PB')) {
        isEligible = false;
        failedReason = 'Não atende restrição estadual';
      }
    }

    // Rule B (Geography - municipios_permitidos):
    // If municipios_permitidos has items, and "João Pessoa" is NOT in the array, the NGO fails.
    if (isEligible && municipios_permitidos && municipios_permitidos.length > 0) {
      if (!municipios_permitidos.includes('João Pessoa')) {
        isEligible = false;
        failedReason = 'Não atende restrição municipal';
      }
    }

    // Rule C (Theme - foco vs temas_principais):
    // If any string in temas_principais matches strings inside the NGO's foco (case-insensitive string includes), give it +1 match score.
    if (isEligible && temas_principais && temas_principais.length > 0) {
      const foco = (ngo.foco || '').toLowerCase();
      for (const tema of temas_principais) {
        if (foco.includes(tema.toLowerCase())) {
          score += 1;
        }
      }
    }

    return {
      ...ngo,
      eligibility: {
        isEligible,
        failedReason: failedReason || undefined,
        score
      }
    };
  });
}
