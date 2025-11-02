/**
 * src/services/giapService.js
 * Funções específicas para carregar e processar dados da planilha GIAP.
 */

export const GIAP_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTaVN5Oiv5eDmdJpsCCys-0TQb9q-QaOeTqakTE6wBYup2sJYnPf2_uNIYkmrI7FIvis1aUxv21vB_k/pub?output=csv';

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
