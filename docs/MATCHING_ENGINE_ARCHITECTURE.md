# Matching Engine Architecture

The Matching Engine utilizes a strictly enforced **"Zero-Billing" 3-Phase Funnel Architecture**. This approach guarantees that computationally expensive or financially costly AI operations are only performed on highly qualified candidates. It explicitly forbids the use of paid vector databases and paid embedding models.

## Phase 1: K.O. Filter (Pure TypeScript)

The first phase acts as a ruthless, deterministic filter. It is implemented purely in TypeScript and runs instantly. Its sole purpose is to evaluate hard bureaucratic constraints from the `criterios_eliminatorios` object in the parsed edital against the NGO profiles. It returns a simple boolean (`isEligible`) and a `failedReason` if rejected. No thematic or semantic analysis happens here.

**Core Rules Executed in Phase 1:**
1.  **National Coverage:** Checks if `abrangencia_nacional === true`. If it is true, the geography check automatically passes.
2.  **Geography Validation (String Matching):** Validates the NGO's location against `estados_permitidos` and `municipios_permitidos`. It uses normalized, case-insensitive partial string matching to avoid false negatives caused by formatting inconsistencies (e.g., comparing "PB" to "Paraíba - PB").
3.  **Minimum Age Check:** Validates the NGO's years of operation against the edital's `idade_minima_cnpj_anos`.
4.  **Legal Nature Exclusion:** Checks the NGO's legal nature against the `natureza_juridica_excluida` array to disqualify prohibited entity types.

## Phase 2: Semantic Reranking (Gemini LLM)

Once the candidate pool is reduced to only eligible NGOs via the Phase 1 K.O. Filter, Phase 2 performs semantic reranking.

*   **Technology:** Uses the Gemini LLM (specifically `gemini-3.5-flash-lite` via the free Google AI Studio API) to evaluate thematic alignment.
*   **Methodology:** Compares the NGO's focus (`foco`) against the edital's `temas_principais`.
*   **Safety Constraints:** To prevent hallucinations and adhere to free-tier limits, the prompts are strictly chunked and batched to a maximum of 15-20 items per request. Robust rate-limiting (e.g., batching and sleeping) is implemented to respect the 15 Requests Per Minute (RPM) quota.

## Phase 3: Deep-Dive Document Analysis

The final phase involves a deep-dive analysis of the highest-ranked candidates from Phase 2 against the full text or PDF of the edital. This is an intensive process designed to extract and verify complex compliance requirements and generate the final match recommendations.
