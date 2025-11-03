/**
 * src/services/giapService.js
 * Funções específicas para carregar e processar dados da planilha GIAP.
 */

// INÍCIO DA ALTERAÇÃO: O link da planilha GIAP (primeira aba)
// Este é o link que você forneceu, convertido para CSV. Ele carrega a PRIMEIRA ABA (chamada "GIAP").
export const GIAP_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTaVN5Oiv5eDmdJpsCCys-0TQb9q-QaOeTqakTE6wBYup2sJYnPf2_uNIYkmrI7FIvis1aUxv21vB_k/pub?output=csv';

// NOTA: A solicitação para usar a aba "Notas fiscais" é complexa.
// O PapaParse só pode carregar UMA aba (a primeira publicada) por URL.
// Para carregar a aba "Notas fiscais" (que é a segunda), precisaríamos de um link com um `gid` diferente.
// No entanto, os cabeçalhos que você descreveu (TOMBAMENTO, Descrição, NF, etc.)
// JÁ ESTÃO na aba "GIAP" que o sistema está carregando.
// As melhorias de lógica (como 014032 vs 14032) foram feitas em `edit.js` para usar ESTES dados.
// FIM DA ALTERAÇÃO

/**
 * Carrega a planilha GIAP (Google Sheets) via PapaParse.
 * @returns {Promise<Array<object>>} Inventário completo do GIAP.
 */
export function loadGiapInventory() {
    return new Promise((resolve, reject) => {
        // PapaParse é carregado via script tag no HTML
        Papa.parse(GIAP_SHEET_URL, {
            download: true,
            header: true,
            skipEmptyLines: true,
            transformHeader: header => header.trim(),
            complete: r => resolve(r.data),
            error: e => reject(e)
        });
    });
}
