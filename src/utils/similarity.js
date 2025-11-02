/**
 * src/utils/similarity.js
 * Funções que implementam a lógica de similaridade de texto, útil para conciliação de inventário.
 */

import { normalizeStr } from './helpers.js';

/**
 * Calcula a distância de Levenshtein (edição) entre duas strings.
 * @param {string} s1 - Primeira string.
 * @param {string} s2 - Segunda string.
 * @returns {number} A distância de edição.
 */
function levenshteinDistance(s1, s2) {
    const len1 = s1.length;
    const len2 = s2.length;
    // Otimização para strings muito diferentes
    if (Math.abs(len1 - len2) > 20) return Math.max(len1, len2);
    
    const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));
    for (let i = 0; i <= len1; i++) matrix[0][i] = i;
    for (let j = 0; j <= len2; j++) matrix[j][0] = j;

    for (let j = 1; j <= len2; j++) {
        for (let i = 1; i <= len1; i++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,      // inserção
                matrix[j - 1][i] + 1,      // deleção
                matrix[j - 1][i - 1] + cost // substituição
            );
        }
    }
    return matrix[len2][len1];
}

/**
 * Calcula uma pontuação de similaridade composta entre duas strings.
 * A pontuação usa índice de Jaccard, bônus de substring e distância de Levenshtein.
 * Esta é a base para as sugestões de conciliação.
 * @param {string} str1 - Primeira string para comparação.
 * @param {string} str2 - Segunda string para comparação.
 * @returns {number} Pontuação de similaridade entre 0.0 e 1.0.
 */
export function calculateSimilarity(str1, str2) {
    const s1 = normalizeStr(str1);
    const s2 = normalizeStr(str2);
    if (s1 === s2) return 1.0;

    // Bônus se uma string contém a outra
    if (s1.includes(s2) || s2.includes(s1)) return 0.92;

    // 1. Índice de Jaccard (baseado em palavras)
    const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
    if (words1.size === 0 && words2.size === 0) return 0;
    
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    const jaccardScore = union.size > 0 ? intersection.size / union.size : 0;

    // 2. Bônus de Substring Longa
    let substringBonus = 0;
    const minLen = Math.min(s1.length, s2.length);
    for (let size = Math.min(8, minLen); size >= 4; size--) {
        let found = false;
        for (let i = 0; i <= s1.length - size; i++) {
            const substr = s1.substring(i, i + size);
            if (s2.includes(substr)) {
                substringBonus = Math.max(substringBonus, (size / Math.max(s1.length, s2.length)) * 0.3);
                found = true;
                break;
            }
        }
        if (found) break;
    }
    
    // 3. Bônus de Levenshtein
    let levBonus = 0;
    if (s1.length < 50 && s2.length < 50) {
        const distance = levenshteinDistance(s1, s2);
        const maxLen = Math.max(s1.length, s2.length);
        // Garante que o bônus de Levenshtein seja menos dominante
        levBonus = maxLen > 0 ? (1 - distance / maxLen) * 0.2 : 0;
    }

    // Combinação ponderada
    return Math.min(jaccardScore * 0.6 + substringBonus + levBonus, 1.0);
}
