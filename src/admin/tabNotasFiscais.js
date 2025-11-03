/**
 * /src/admin/tabNotasFiscais.js
 * Lógica da aba "Notas Fiscais" (content-notas_fiscais).
 */

import { getState } from '../state/globalStore.js';
import { showNotification, normalizeStr, debounce, escapeHtml, normalizeTombo, parsePtBrDate } from '../utils/helpers.js';

const DOM_NF = {
    nfContainer: document.getElementById('notas-fiscais-container'),
    nfSearch: document.getElementById('nf-search'),
    nfItemSearch: document.getElementById('nf-item-search'),
    nfFornecedorSearch: document.getElementById('nf-fornecedor-search'),
    nfTipoEntrada: document.getElementById('nf-tipo-entrada'),
    nfStatusFilter: document.getElementById('nf-status-filter'),
    nfDateStart: document.getElementById('nf-date-start'),
    nfDateEnd: document.getElementById('nf-date-end'),
    nfClearFiltersBtn: document.getElementById('clear-nf-filters-btn'),
};

let nfDataCache = null; 

// --- FUNÇÕES DE UTILITY ---

/**
 * Processa dados do GIAP para agrupar por NF.
 * @returns {object} Objeto com NFs como chaves.
 */
function processNfData(giapInventory) {
    if (nfDataCache) return nfDataCache;

    if (giapInventory.length === 0) return {};

    const giapWithNf = giapInventory
        .filter(item => item.NF && item.NF.trim() !== '')
        .sort((a, b) => parsePtBrDate(b.Cadastro) - parsePtBrDate(a.Cadastro));
    
    nfDataCache = giapWithNf.reduce((acc, item) => {
        const nf = item.NF.trim();
        if (!acc[nf]) {
            acc[nf] = {
                items: [],
                fornecedor: item['Nome Fornecedor'] || 'Não especificado',
                tipoEntrada: item['Tipo Entrada'] || 'N/A',
                dataCadastro: item.Cadastro
            };
        }
        acc[nf].items.push(item);
        return acc;
    }, {});
    
    return nfDataCache;
}

// --- FUNÇÕES DE RENDERIZAÇÃO ---

export function populateNfTab() {
    // Popula o filtro de status (simples, baseado nos status do GIAP)
    DOM_NF.nfStatusFilter.innerHTML = `
        <option value="">Todos os Status</option>
        <option value="Disponível">Disponível</option>
        <option value="Em Uso">Em Uso</option>
        <option value="Baixado">Baixado</option>
    `;
    renderNfList();
}

/**
 * Renderiza a lista de Notas Fiscais com base nos filtros.
 */
export function renderNfList() {
    const { patrimonioFullList, giapInventory } = getState();
    const processedNfData = processNfData(giapInventory);
    const container = DOM_NF.nfContainer;

    if (!container) return;
    container.innerHTML = '';
    if (Object.keys(processedNfData).length === 0) {
        container.innerHTML = `<p class="text-slate-500 text-center p-4">Nenhuma nota fiscal encontrada na planilha GIAP.</p>`;
        return;
    } 

    const tomboMap = new Map(patrimonioFullList.map(item => [normalizeTombo(item.Tombamento), item]));
    
    // Filtros
    const nfSearchTerm = normalizeStr(DOM_NF.nfSearch.value);
    const itemSearchTerm = normalizeStr(DOM_NF.nfItemSearch.value);
    const fornecedorSearchTerm = normalizeStr(DOM_NF.nfFornecedorSearch.value);
    const tipoEntrada = normalizeStr(DOM_NF.nfTipoEntrada.value);
    const statusFilter = normalizeStr(DOM_NF.nfStatusFilter.value);
    const dateStart = DOM_NF.nfDateStart.value ? new Date(DOM_NF.nfDateStart.value) : null;
    const dateEnd = DOM_NF.nfDateEnd.value ? new Date(DOM_NF.nfDateEnd.value) : null;

    const filteredNfs = Object.keys(processedNfData).filter(nf => {
        const nfGroup = processedNfData[nf];

        // Filtro por Número da NF
        if (nfSearchTerm && !normalizeStr(nf).includes(nfSearchTerm)) return false;
        
        // Filtro por Fornecedor
        if (fornecedorSearchTerm && !normalizeStr(nfGroup.fornecedor).includes(fornecedorSearchTerm)) return false;
        
        // Filtro por Tipo de Entrada
        if (tipoEntrada && normalizeStr(nfGroup.tipoEntrada) !== tipoEntrada) return false;

        // Filtro por Data
        if (dateStart && parsePtBrDate(nfGroup.dataCadastro) < dateStart) return false;
        if (dateEnd && parsePtBrDate(nfGroup.dataCadastro) > dateEnd) return false;
        
        // Filtro por Item (Descrição/Espécie) e Status
        let itemMatch = false;
        let statusMatch = !statusFilter; // Se não há filtro de status, qualquer item serve
        
        nfGroup.items.forEach(item => {
            // Verifica se o item corresponde à busca
            if (itemSearchTerm && (normalizeStr(item.Descrição).includes(itemSearchTerm) || normalizeStr(item.Espécie).includes(itemSearchTerm))) {
                itemMatch = true;
            }
            
            // Se houver filtro de status
            if (statusFilter) {
                const tombo = normalizeTombo(item.TOMBAMENTO);
                const allocatedItem = tombo ? tomboMap.get(tombo) : null;
                
                let currentStatus = normalizeStr(item.Status); // Status da Planilha
                let inventoryStatus = allocatedItem ? 'em uso' : 'disponível';
                if(currentStatus.includes('baixado')) inventoryStatus = 'baixado';
                
                if (inventoryStatus.includes(statusFilter)) {
                    statusMatch = true;
                }
            } else {
                 statusMatch = true; // Se não filtra por status, assume true
            }
        });
        
        // Se houver filtro de item, a NF deve ter pelo menos um item que combine.
        // Se não houver filtro de item, o status deve ser válido (statusMatch deve ser true).
        return (itemSearchTerm ? itemMatch : true) && statusMatch;
    });

    if (filteredNfs.length === 0) {
        container.innerHTML = `<p class="text-slate-500 text-center p-4">Nenhuma nota fiscal encontrada com os filtros aplicados.</p>`;
        return;
    }
    
    // Renderização
    filteredNfs.slice(0, 100).forEach(nf => { 
        const nfGroup = processedNfData[nf];
        const nfDetails = document.createElement('details');
        nfDetails.className = 'bg-white rounded-lg shadow-sm border mb-3';
        const itemSummaryText = nfGroup.items.slice(0, 2).map(i => escapeHtml(i.Descrição || i.Espécie)).join(', ') + (nfGroup.items.length > 2 ? '...' : '');

        nfDetails.innerHTML = `
            <summary class="p-4 font-semibold cursor-pointer grid grid-cols-1 md:grid-cols-3 gap-4 items-center hover:bg-slate-50">
                <div class="md:col-span-2">
                    <p class="text-xs text-slate-500">NF: <strong class="text-blue-700 text-sm">${escapeHtml(nf)}</strong> | Fornecedor: <strong>${escapeHtml(nfGroup.fornecedor)}</strong></p>
                    <p class="text-xs text-slate-500 mt-1 truncate">Itens: ${itemSummaryText}</p>
                </div>
                <div><p class="text-xs text-slate-500">Data Cadastro</p><strong>${escapeHtml(nfGroup.dataCadastro)}</strong></div>
            </summary>
            <div class="p-4 border-t border-slate-200 space-y-2">
                ${nfGroup.items.map(item => {
                    const tombo = normalizeTombo(item.TOMBAMENTO);
                    const allocatedItem = tombo ? tomboMap.get(tombo) : undefined;
                    let allocationHtml = '';
                    
                    if (allocatedItem) {
                        allocationHtml = `<span class="badge badge-green">Alocado em: ${escapeHtml(allocatedItem.Unidade)}</span>`;
                    } else if (normalizeStr(item.Status).includes('baixado')) {
                         allocationHtml = `<span class="badge badge-red">Status: Baixado</span>`;
                    } else {
                        allocationHtml = `<span class="badge badge-blue">Disponível</span>`;
                    }
                    
                    return `<div class="p-3 border rounded-md flex justify-between items-center bg-slate-50/50">
                                <div><p class="font-bold text-slate-800">${escapeHtml(item.Descrição || item.Espécie)}</p><p class="text-sm text-slate-500">Tombo: <span class="font-mono">${escapeHtml(tombo || 'N/D')}</span></p></div>
                                <div class="text-right ml-4">${allocationHtml}</div>
                            </div>`;
                }).join('')}
            </div>
        `;
        container.appendChild(nfDetails);
    });
}

// --- LISTENERS ---

export function setupNotasFiscaisListeners() {
    const debouncedRender = debounce(renderNfList, 300);

    DOM_NF.nfSearch.addEventListener('input', debouncedRender);
    DOM_NF.nfItemSearch.addEventListener('input', debouncedRender);
    DOM_NF.nfFornecedorSearch.addEventListener('input', debouncedRender);
    DOM_NF.nfTipoEntrada.addEventListener('change', debouncedRender);
    DOM_NF.nfStatusFilter.addEventListener('change', debouncedRender);
    DOM_NF.nfDateStart.addEventListener('change', debouncedRender);
    DOM_NF.nfDateEnd.addEventListener('change', debouncedRender);

    DOM_NF.nfClearFiltersBtn.addEventListener('click', () => {
        DOM_NF.nfSearch.value = '';
        DOM_NF.nfItemSearch.value = '';
        DOM_NF.nfFornecedorSearch.value = '';
        DOM_NF.nfTipoEntrada.value = '';
        DOM_NF.nfStatusFilter.value = '';
        DOM_NF.nfDateStart.value = '';
        DOM_NF.nfDateEnd.value = '';
        renderNfList();
    });
}
