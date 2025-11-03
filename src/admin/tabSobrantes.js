/**
 * /src/admin/tabSobrantes.js
 * Lógica da aba "Tombos Sobrando" (content-sobrando).
 */

import { getState } from '../state/globalStore.js';
import { showNotification, normalizeStr, debounce, escapeHtml, normalizeTombo } from '../utils/helpers.js';

const DOM_SOBRAS = {
    leftoverKeyword: document.getElementById('leftover-keyword'),
    leftoverTombo: document.getElementById('leftover-tombo'),
    suggestSobrandoBtn: document.getElementById('suggest-sobrando'),
    totalSobrando: document.getElementById('total-sobrando'),
    sobrandoList: document.getElementById('sobrando-list'),
};

/**
 * Retorna todos os tombos do GIAP que estão 'Disponíveis' e ainda não
 * foram alocados para nenhum item no `fullInventory`.
 */
function getGlobalLeftovers() {
    const { patrimonioFullList, giapInventory } = getState();
    const usedTombamentos = new Set(patrimonioFullList.map(i => normalizeTombo(i.Tombamento)).filter(Boolean));
    
    return giapInventory.filter(g => {
        const tombo = normalizeTombo(g.TOMBAMENTO);
        return tombo && 
               !tombo.includes('permuta') && 
               !usedTombamentos.has(tombo) && 
               normalizeStr(g.Status).includes(normalizeStr('Disponível'));
    });
}

/**
 * Renderiza uma lista de itens (Sistema ou GIAP) no container apropriado.
 * Adaptada do tabConciliar.js para ser simples.
 */
function renderList(arr) {
    const container = DOM_SOBRAS.sobrandoList;
    container.innerHTML = '';
    
    if (!arr || arr.length === 0) {
        container.innerHTML = `<p class="p-4 text-slate-500 text-center">Nenhum item sobrando encontrado com os filtros.</p>`;
        return;
    }
    
    arr.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'reconciliation-list-item p-2 border-b';
        
        div.innerHTML = `
            <p class="font-semibold">${escapeHtml(item.Descrição || item.Espécie)}</p>
            <p class="text-sm text-slate-500">Tombo: <span class="font-mono">${escapeHtml(item.TOMBAMENTO)}</span></p>
            <p class="text-xs text-blue-600 font-semibold mt-1">Unidade GIAP: ${escapeHtml(item.Unidade || 'N/A')}</p>
        `;

        container.append(div);
    });
}

/**
 * Busca e renderiza os tombos sobrando com base nos filtros.
 */
function searchAndRenderSobrantes() {
    const keyword = normalizeStr(DOM_SOBRAS.leftoverKeyword.value);
    const tomboFilter = normalizeStr(DOM_SOBRAS.leftoverTombo.value);
    
    const leftovers = getGlobalLeftovers();
    
    const filtered = leftovers.filter(item => {
        const tomboItem = normalizeTombo(item.TOMBAMENTO);
        const descItem = normalizeStr(item.Descrição || item.Espécie);
        const matchesKeyword = !keyword || descItem.includes(keyword);
        const matchesTombo = !tomboFilter || tomboItem.includes(tomboFilter);
        return matchesKeyword && matchesTombo;
    });

    DOM_SOBRAS.totalSobrando.textContent = filtered.length;
    renderList(filtered);
    showNotification(`Encontrados ${filtered.length} tombos sobrando.`, 'info');
}

// --- LISTENERS ---

export function setupSobrantesListeners() {
    const debouncedSearch = debounce(searchAndRenderSobrantes, 300);

    DOM_SOBRAS.suggestSobrandoBtn.addEventListener('click', searchAndRenderSobrantes);
    DOM_SOBRAS.leftoverKeyword.addEventListener('input', debouncedSearch);
    DOM_SOBRAS.leftoverTombo.addEventListener('input', debouncedSearch);
}
