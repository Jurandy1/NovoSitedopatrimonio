/**
 * /src/admin/tabConciliar.js
 * Lógica da aba "Conciliar Itens" (content-conciliar) e suas sub-abas.
 */

import { db, serverT, writeBatch, doc, setDoc, updateDoc, collection } from '../services/firebase.js';
import { getState, setState } from '../state/globalStore.js';
import { showNotification, showOverlay, hideOverlay, normalizeStr, debounce, escapeHtml, normalizeTombo } from '../utils/helpers.js';
import { idb } from '../services/cache.js';

const DOM_CONC = {
    // Principal
    conciliarFilterTipo: document.getElementById('filter-tipo'),
    conciliarFilterUnidade: document.getElementById('filter-unidade'),
    loadConciliarBtn: document.getElementById('load-conciliar'),
    unitReconciledWarning: document.getElementById('unit-reconciled-warning'),
    // giapListUnitName: document.getElementById('giap-list-unit-name'), // Removido
    
    // Sub-aba Unidade
    systemListFilter: document.getElementById('system-list-filter'),
    systemList: document.getElementById('system-list'),
    giapListFilter: document.getElementById('giap-list-filter'),
    giapList: document.getElementById('giap-list'),
    quickActions: document.getElementById('quick-actions'),
    createdLinks: document.getElementById('created-links'),
    saveLinksBtn: document.getElementById('save-links'),
    clearSelectionsBtn: document.getElementById('clear-selections'),
    finishReconciliationBtn: document.getElementById('finish-reconciliation-btn'),
    importGiapBtn: document.getElementById('import-giap-btn'),
    giapImportCount: document.getElementById('giap-import-count'),
    importEstadoSelect: document.getElementById('import-estado-select'),

    // Sub-aba Sobras
    sobrasFilterTipo: document.getElementById('sobras-filter-tipo'),
    sobrasFilterUnidade: document.getElementById('sobras-filter-unidade'),
    loadSobrasConciliarBtn: document.getElementById('load-sobras-conciliar'),
    sobrasSystemList: document.getElementById('sobras-system-list'),
    sobrasSystemListFilter: document.getElementById('sobras-system-list-filter'),
    sobrasGiapList: document.getElementById('sobras-giap-list'),
    sobrasGiapListFilter: document.getElementById('sobras-giap-list-filter'),
    sobrasGiapTypeFilter: document.getElementById('sobras-giap-type-filter'),
    sobrasQuickActions: document.getElementById('sobras-quick-actions'),
    sobrasCreatedLinks: document.getElementById('sobras-created-links'),
    sobrasSaveLinksBtn: document.getElementById('sobras-save-links'),
    sobrasClearSelectionsBtn: document.getElementById('sobras-clear-selections'),
    
    // Sub-aba Itens a Tombar
    tombarFilterTipo: document.getElementById('tombar-filter-tipo'),
    tombarFilterUnidade: document.getElementById('tombar-filter-unidade'),
    itensATombarContainer: document.getElementById('itens-a-tombar-container'),
    
    // Modais
    descChoiceModal: document.getElementById('desc-choice-modal'),
    descChoiceCancelBtn: document.getElementById('desc-choice-cancel-btn'),
    descChoiceKeepBtn: document.getElementById('desc-choice-keep-btn'),
    descChoiceUpdateBtn: document.getElementById('desc-choice-update-btn'),
};

// --- ESTADO LOCAL/TRANSITÓRIO DA CONCILIAÇÃO ---
let selSys = null, selGiap = null; // Seleções para conciliação
let linksToCreate = []; // Lista de vínculos pendentes
let giapItemsForImport = []; // Para importação direta

// --- FUNÇÕES DE UTILITY (Compartilhadas) ---

/**
 * Retorna todos os tombos do GIAP que estão 'Disponíveis' e ainda não
 * foram alocados para nenhum item no `fullInventory`.
 */
function getGlobalLeftovers() {
    const { patrimonioFullList, giapInventory } = getState();
    const usedTombamentos = new Set(patrimonioFullList.map(i => normalizeTombo(i.Tombamento)).filter(Boolean));
    linksToCreate.forEach(link => usedTombamentos.add(normalizeTombo(link.giapItem.TOMBAMENTO)));
    
    return giapInventory.filter(g => {
        const tombo = normalizeTombo(g.TOMBAMENTO);
        return tombo && 
               !tombo.includes('permuta') && 
               !usedTombamentos.has(tombo) && 
               normalizeStr(g.Status).includes(normalizeStr('Disponível'));
    });
}

/**
 * Filtra os itens do Sistema (S/T) e do GIAP (Disponíveis) para a unidade de conciliação ativa.
 */
function getConciliationData(context = 'unidade') {
    const { patrimonioFullList, giapInventory, unitMapping } = getState();
    const unidade = context === 'unidade' ? DOM_CONC.conciliarFilterUnidade.value.trim() : DOM_CONC.sobrasFilterUnidade.value.trim();
    if (!unidade) return { systemItems: [], giapItems: [] };
    
    const systemFilterText = normalizeStr(context === 'unidade' ? DOM_CONC.systemListFilter.value : DOM_CONC.sobrasSystemListFilter.value);
    const giapFilterText = normalizeStr(context === 'unidade' ? DOM_CONC.giapListFilter.value : DOM_CONC.sobrasGiapListFilter.value);

    // Tombos já em uso no inventário GERAL ou na lista de links PENDENTES
    const usedTombamentos = new Set(patrimonioFullList.map(i => normalizeTombo(i.Tombamento)).filter(Boolean));
    linksToCreate.forEach(link => usedTombamentos.add(normalizeTombo(link.giapItem.TOMBAMENTO)));

    // Itens do Sistema: S/T, na unidade selecionada, não pendentes, e correspondem ao filtro
    const systemItems = patrimonioFullList.filter(i => {
        const tombo = (i.Tombamento || '').trim().toLowerCase();
        const isPending = linksToCreate.some(l => l.systemItem.id === i.id);
        return !isPending &&
               !i.isPermuta &&
               i.Unidade === unidade &&
               (tombo === '' || tombo === 's/t') &&
               normalizeStr(i.Descrição).includes(systemFilterText);
    });

    let giapItems;
    if (context === 'unidade') {
        // Unidades do GIAP que correspondem à unidade do sistema selecionada
        const mappedGiapUnits = (unitMapping[unidade] || [unidade]).map(normalizeStr);
        // Itens do GIAP: Disponíveis, na unidade mapeada, não em uso, e correspondem ao filtro
        giapItems = giapInventory.filter(g => {
            const tomboTrimmed = normalizeTombo(g.TOMBAMENTO);
            const giapDesc = normalizeStr(g.Descrição || g.Espécie);
            return tomboTrimmed && 
                   !usedTombamentos.has(tomboTrimmed) && 
                   mappedGiapUnits.includes(normalizeStr(g.Unidade)) &&
                   normalizeStr(g.Status).includes(normalizeStr('Disponível')) &&
                   giapDesc.includes(giapFilterText);
        });
    } else { // Contexto 'sobras'
        giapItems = getFilteredSobrantes();
    }

    return { systemItems, giapItems };
}

/**
 * Filtra as sobras globais do GIAP para o contexto "Conciliar com Sobras".
 */
function getFilteredSobrantes() {
    let allLeftovers = getGlobalLeftovers();
    const giapTypeFilter = DOM_CONC.sobrasGiapTypeFilter.value;
    const giapDescFilter = normalizeStr(DOM_CONC.sobrasGiapListFilter.value);
    const { patrimonioFullList, unitMapping } = getState();
    
    // Mapeia Unidade GIAP -> Tipo do Sistema
    const giapUnitToSystemType = {};
    Object.keys(unitMapping).forEach(systemUnit => {
        const systemUnitType = (patrimonioFullList.find(i => i.Unidade === systemUnit) || {}).Tipo;
        if(systemUnitType){
            unitMapping[systemUnit].forEach(giapUnit => { giapUnitToSystemType[giapUnit] = systemUnitType; });
        }
    });

    if (giapTypeFilter) {
        allLeftovers = allLeftovers.filter(item => (giapUnitToSystemType[item.Unidade] || 'Não Mapeado') === giapTypeFilter);
    }
    
    if (giapDescFilter) {
        allLeftovers = allLeftovers.filter(item => normalizeStr(item.Descrição || item.Espécie).includes(giapDescFilter));
    }
    return allLeftovers;
}

// --- FUNÇÕES DE RENDERIZAÇÃO ---

/**
 * Popula os filtros da aba "Conciliar Itens".
 */
export function populateReconciliationTab() {
    const { patrimonioFullList } = getState();

    // Deduplica e popula tipos
    const tiposMap = new Map();
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!tiposMap.has(normalized)) {
            tiposMap.set(normalized, tipo.trim());
        }
    });
    const tipos = [...tiposMap.values()].sort();

    // Filtros principais
    DOM_CONC.conciliarFilterTipo.innerHTML = '<option value="">Selecione um Tipo</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    DOM_CONC.conciliarFilterUnidade.disabled = true;
    
    // Filtros Sobras
    const reconciledTypesMap = new Map();
    getState().reconciledUnits.map(unitName => {
        const item = patrimonioFullList.find(i => i.Unidade === unitName);
        if(item && item.Tipo) {
            const normalized = normalizeStr(item.Tipo);
            if (!reconciledTypesMap.has(normalized)) {
                reconciledTypesMap.set(normalized, item.Tipo.trim());
            }
        }
    });
    const reconciledTypes = [...reconciledTypesMap.values()].sort();
    DOM_CONC.sobrasFilterTipo.innerHTML = '<option value="">Selecione um Tipo</option>' + reconciledTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    DOM_CONC.sobrasFilterUnidade.disabled = true;

    // Filtros Itens a Tombar
    DOM_CONC.tombarFilterTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    DOM_CONC.tombarFilterUnidade.disabled = true;

    // Filtro de Tipo para Sobras do GIAP
    DOM_CONC.sobrasGiapTypeFilter.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
}


/**
 * Renderiza ambas as listas (Sistema e GIAP) na aba de conciliação ativa.
 * @param {string} context - 'unidade' ou 'sobras'
 */
function renderConciliationLists(context = 'unidade') {
    const unidade = context === 'unidade' ? DOM_CONC.conciliarFilterUnidade.value.trim() : DOM_CONC.sobrasFilterUnidade.value.trim();
    const listSys = context === 'unidade' ? DOM_CONC.systemList : DOM_CONC.sobrasSystemList;
    const listGiap = context === 'unidade' ? DOM_CONC.giapList : DOM_CONC.sobrasGiapList;
    
    if (!unidade) {
        listSys.innerHTML = `<p class="p-4 text-slate-500 text-center">Selecione uma unidade e clique em carregar.</p>`;
        listGiap.innerHTML = `<p class="p-4 text-slate-500 text-center">Selecione uma unidade e clique em carregar.</p>`;
        return;
    }
    
    const { systemItems, giapItems } = getConciliationData(context);
    
    renderList(listSys.id, systemItems, 'id', 'Descrição', context);
    renderList(listGiap.id, giapItems, 'TOMBAMENTO', 'Descrição', context);
    
    // Mostra/Esconde a seção de ações rápidas
    const quickActions = context === 'unidade' ? DOM_CONC.quickActions : DOM_CONC.sobrasQuickActions;
    quickActions.classList.toggle('hidden', systemItems.length === 0 && giapItems.length === 0 && linksToCreate.length === 0);

    // Garante que os links já criados permaneçam marcados
    linksToCreate.forEach(link => {
        const sysEl = listSys.querySelector(`div[data-id='${link.systemItem.id}']`);
        const giapEl = listGiap.querySelector(`div[data-id='${link.giapItem.TOMBAMENTO}']`);
        if (sysEl) sysEl.classList.add('linked');
        if (giapEl) giapEl.classList.add('linked');
    });

    // Garante que itens selecionados para importação permaneçam marcados
    if (context === 'unidade') {
        giapItemsForImport.forEach(item => {
            const giapEl = listGiap.querySelector(`div[data-id='${item.TOMBAMENTO}']`);
            if (giapEl) giapEl.classList.add('selected-for-import');
        });
        updateImportButton();
    }
}

/**
 * Renderiza uma lista de itens (Sistema ou GIAP) no container apropriado.
 */
function renderList(containerId, arr, keyField, primaryLabelField, context) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    
    if (!arr || arr.length === 0) {
        container.innerHTML = `<p class="p-4 text-slate-500 text-center">Nenhum item encontrado.</p>`;
        return;
    }
    
    arr.forEach((item) => {
        const id = item[keyField];
        const div = document.createElement('div');
        div.className = 'reconciliation-list-item p-2 border-b';
        div.dataset.id = id; 
        div.dataset.desc = escapeHtml(item[primaryLabelField] || item.Espécie || '');

        let detailsHtml = '';
        if (containerId.includes('system-list')) {
            // MELHORIA 2: Layout para item do Sistema (S/T) com Estado e Obs
            const estado = escapeHtml(item.Estado || 'N/D');
            const estadoClass = estado === 'Novo' ? 'badge-green' : estado === 'Bom' ? 'badge-blue' : estado === 'Avariado' ? 'badge-red' : 'badge-yellow';
            
            detailsHtml = `
                <p class="font-semibold">${escapeHtml(item[primaryLabelField])}</p>
                <p class="text-xs text-slate-500">${escapeHtml(item.Localização) || 'Sem local'}</p>
                <div class="mt-1">
                    <span class="badge ${estadoClass}">${estado}</span>
                </div>
                ${item.Observação ? `<p class="text-xs text-slate-600 mt-1 truncate" title="${escapeHtml(item.Observação)}">Obs: ${escapeHtml(item.Observação)}</p>` : ''}
            `;
        } else {
            // MELHORIA 1: Layout para item do GIAP (Tombo) com mais campos
            detailsHtml = `
                <p class="font-semibold">${escapeHtml(item.Descrição || item.Espécie)}</p>
                <p class="text-xs text-slate-500">Tombo: <span class="font-mono">${escapeHtml(item.TOMBAMENTO)}</span></p>
                <div class="mt-2 text-xs text-slate-600 space-y-1 border-t pt-1">
                    <p><strong>Cadastro:</strong> ${escapeHtml(item.Cadastro || 'N/A')}</p>
                    <p><strong>Fornecedor:</strong> ${escapeHtml(item['Nome Fornecedor'] || 'N/A')}</p>
                    <p><strong>Valor:</strong> ${escapeHtml(item['Valor NF'] || 'N/A')} | <strong>Entrada:</strong> ${escapeHtml(item['Tipo Entrada'] || 'N/A')}</p>
                </div>
            `;
            if (context === 'sobras') {
                 detailsHtml += `<p class="text-xs text-blue-600 font-semibold mt-1">Unidade GIAP: ${escapeHtml(item.Unidade || 'N/A')}</p>`;
            }
        }
        div.innerHTML = detailsHtml;

        div.onclick = (event) => handleSelect(containerId, id, item, event.currentTarget, context);
        container.append(div);
    });
}

/**
 * Renderiza a lista de links pendentes.
 */
function renderCreatedLinks(context = 'unidade') {
    const container = context === 'unidade' ? DOM_CONC.createdLinks : DOM_CONC.sobrasCreatedLinks;
    container.innerHTML = linksToCreate.map((link, index) => {
        const systemDesc = link.systemItem.Descrição;
        const giapDesc = link.giapItem.Descrição || link.giapItem.Espécie;
        const finalDesc = link.useGiapDescription ? giapDesc : systemDesc;

        return `<div class="created-link-item p-2 text-sm bg-green-50 border-l-4 border-green-500 flex justify-between items-center">
                    <span>
                        <strong>S/T:</strong> ${escapeHtml(systemDesc)} ↔ 
                        <strong>Tombo:</strong> ${escapeHtml(link.giapItem.TOMBAMENTO)}<br>
                        <span class="text-xs text-blue-700">Usar Descrição: "${escapeHtml(finalDesc)}"</span>
                    </span>
                    <button class="delete-link-btn p-1 text-red-500 hover:bg-red-100 rounded-full" data-index="${index}" title="Remover Vínculo">
                        <svg class="pointer-events-none" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11v1z"/></svg>
                    </button>
                </div>`;
    }).join('');
}

/**
 * Renderiza itens pendentes de tombamento na sub-aba "Itens S/T a Tombar".
 */
export function renderItensATombar() {
    const { patrimonioFullList } = getState();
    const container = DOM_CONC.itensATombarContainer;
    const tipo = DOM_CONC.tombarFilterTipo.value;
    const unidade = DOM_CONC.tombarFilterUnidade.value;

    const itemsPendentes = patrimonioFullList.filter(item => 
        item.etiquetaPendente === true &&
        (!tipo || item.Tipo === tipo) &&
        (!unidade || item.Unidade === unidade)
    );

    if (itemsPendentes.length === 0) {
        container.innerHTML = '<p class="text-slate-500 text-center p-4">Nenhum item pendente de tombamento com os filtros selecionados.</p>';
        return;
    }

    const groupedByTipo = itemsPendentes.reduce((acc, item) => {
        const tipoKey = item.Tipo || 'Sem Tipo';
        if (!acc[tipoKey]) acc[tipoKey] = [];
        acc[tipoKey].push(item);
        return acc;
    }, {});

    let html = '';
    for (const tipo of Object.keys(groupedByTipo).sort()) {
        html += `<h3 class="text-lg font-bold text-slate-700 p-2 bg-slate-100 rounded-t-lg mt-4">${tipo}</h3>`;
        
        const groupedByUnidade = groupedByTipo[tipo].reduce((acc, item) => {
            const unidadeKey = item.Unidade || 'Sem Unidade';
            if (!acc[unidadeKey]) acc[unidadeKey] = [];
            acc[unidadeKey].push(item);
            return acc;
        }, {});

        for (const unidade of Object.keys(groupedByUnidade).sort()) {
            html += `<details class="bg-white rounded-lg shadow-sm border mb-2" open><summary class="p-4 font-semibold cursor-pointer hover:bg-slate-50">${unidade}</summary>
                        <div class="p-2 border-t">
                            <table class="w-full text-sm">
                                <thead><tr class="border-b"><th class="p-2 text-left">Descrição</th><th class="p-2 text-left">Novo Tombo</th><th class="p-2 text-left">Ação</th></tr></thead>
                                <tbody>`;
            
            groupedByUnidade[unidade].forEach(item => {
                html += `<tr class="border-b hover:bg-green-50">
                            <td class="p-2">${escapeHtml(item.Descrição)}</td>
                            <td class="p-2 font-mono">${escapeHtml(item.Tombamento)}</td>
                            <td class="p-2">
                                <button data-id="${item.id}" class="confirmar-tombamento-btn text-xs bg-green-100 text-green-700 px-3 py-1 rounded-md hover:bg-green-200">Confirmar Tombamento</button>
                            </td>
                        </tr>`;
            });
            
            html += `</tbody></table></div></details>`;
        }
    }
    container.innerHTML = html;
}

// --- FUNÇÕES DE AÇÃO ---

/**
 * Lida com a seleção de um item S/T ou um Tombo GIAP.
 */
function handleSelect(containerId, id, obj, element, context) {
    if (element.classList.contains('linked')) return;

    const systemListId = context === 'unidade' ? '#system-list' : '#sobras-system-list';
    const giapListId = context === 'unidade' ? '#giap-list' : '#sobras-giap-list';

    if (containerId.includes('system-list')) {
        // Selecionou um item S/T
        if(context === 'unidade') clearGiapImportSelection();
        selSys = { id, obj };
        selGiap = null; 

        document.querySelectorAll(`${giapListId} .selected`).forEach(el => el.classList.remove('selected'));
        document.querySelectorAll(`${systemListId} .selected, ${systemListId} .selected-for-import`).forEach(el => el.classList.remove('selected', 'selected-for-import'));
        element.classList.add('selected');

    } else if (containerId.includes('giap-list') && selSys) {
        // Selecionou um Tombo GIAP *depois* de um S/T
        selGiap = { tomb: id, obj };
        document.querySelectorAll(`${giapListId} .selected, ${giapListId} .selected-for-import`).forEach(el => el.classList.remove('selected', 'selected-for-import'));
        element.classList.add('selected');
        openDescriptionChoiceModal(); // Pergunta qual descrição usar

    } else if (containerId.includes('giap-list') && !selSys && context === 'unidade') {
        // Selecionou um Tombo GIAP *sem* um S/T (para Importação na aba "Unidade")
        element.classList.toggle('selected-for-import');
        const index = giapItemsForImport.findIndex(item => normalizeTombo(item.TOMBAMENTO) === normalizeTombo(id));
        if (index > -1) {
            giapItemsForImport.splice(index, 1);
        } else {
            giapItemsForImport.push(obj);
        }
        updateImportButton();
    }
}

/**
 * Abre o modal para escolher entre a descrição do Sistema ou do GIAP.
 */
function openDescriptionChoiceModal() {
    if (!selSys || !selGiap) return;
    document.getElementById('desc-choice-tombo').textContent = selGiap.tomb;
    document.getElementById('desc-choice-current').textContent = selSys.obj.Descrição;
    document.getElementById('desc-choice-new').textContent = selGiap.obj.Descrição || selGiap.obj.Espécie;
    DOM_CONC.descChoiceModal.classList.remove('hidden');
}

function closeDescriptionChoiceModal() {
    DOM_CONC.descChoiceModal.classList.add('hidden');
}

/**
 * Adiciona o link (S/T + Tombo) à lista de links pendentes para salvar.
 */
function addLinkToCreate(useGiapDescription, context) {
    const link = {
        systemItem: selSys.obj,
        giapItem: selGiap.obj,
        useGiapDescription
    };
    linksToCreate.push(link);

    renderCreatedLinks(context);
    
    // Marca na lista ativa
    const listSys = context === 'unidade' ? DOM_CONC.systemList : DOM_CONC.sobrasSystemList;
    const listGiap = context === 'unidade' ? DOM_CONC.giapList : DOM_CONC.sobrasGiapList;
    
    const sysEl = listSys.querySelector(`div[data-id='${selSys.id}']`);
    const giapEl = listGiap.querySelector(`div[data-id='${selGiap.tomb}']`);
    if (sysEl) sysEl.classList.add('linked');
    if (giapEl) giapEl.classList.add('linked');

    selSys = selGiap = null;
    document.querySelectorAll('.reconciliation-list-item.selected').forEach(el => el.classList.remove('selected'));
}

/**
 * Salva os links pendentes no Firestore.
 * @returns {Promise<boolean>}
 */
async function savePendingLinks(context = 'unidade', reloadDataCallback) {
    if (linksToCreate.length === 0) return true;

    showOverlay(`Salvando ${linksToCreate.length} vínculos...`);
    const batch = writeBatch(db);
    const { patrimonioFullList } = getState();

    linksToCreate.forEach(link => {
        const { systemItem, giapItem, useGiapDescription } = link;
        const docRef = doc(db, 'patrimonio', systemItem.id);
        
        const newDesc = useGiapDescription ? (giapItem.Descrição || giapItem.Espécie) : systemItem.Descrição;

        batch.update(docRef, {
            Tombamento: giapItem.TOMBAMENTO,
            Descrição: newDesc,
            Fornecedor: giapItem['Nome Fornecedor'],
            NF: giapItem['NF'],
            etiquetaPendente: true,
            updatedAt: serverT()
        });
    });

    try {
        await batch.commit();
        
        // Atualiza o cache local (fullInventory e idb)
        // Esta é uma simplificação. O ideal é o Orquestrador recarregar TUDO,
        // mas faremos o básico para refletir o estado do cache.
        const updatedItemsForCache = [];
        linksToCreate.forEach(link => {
             const { systemItem, giapItem, useGiapDescription } = link;
             const index = patrimonioFullList.findIndex(item => item.id === systemItem.id);
             if (index !== -1) {
                const updatedItem = { ...patrimonioFullList[index] };
                updatedItem.Tombamento = giapItem.TOMBAMENTO;
                updatedItem.Descrição = useGiapDescription ? (giapItem.Descrição || giapItem.Espécie) : systemItem.Descrição;
                updatedItem.Fornecedor = giapItem['Nome Fornecedor'];
                updatedItem.NF = giapItem.NF;
                updatedItem.etiquetaPendente = true;
                patrimonioFullList[index] = updatedItem;
                updatedItemsForCache.push(updatedItem);
             }
        });
        if(updatedItemsForCache.length > 0) {
            await idb.patrimonio.bulkPut(updatedItemsForCache);
        }
        
        setState({ patrimonioFullList }); // Atualiza o estado global
        
        // Reset local state
        const numLinks = linksToCreate.length;
        linksToCreate = [];
        renderCreatedLinks(context);
        
        // Dispara o reload completo no orquestrador
        reloadDataCallback(); 

        // ***** CORREÇÃO: O hideOverlay() estava faltando aqui *****
        hideOverlay(); 
        showNotification(`${numLinks} vínculos salvos com sucesso!`, 'success');

        return true;
    } catch (error) {
        hideOverlay();
        showNotification('Erro ao salvar os vínculos.', 'error');
        console.error("Erro ao salvar vínculos:", error);
        return false;
    }
}

function updateImportButton() {
    const count = giapItemsForImport.length;
    DOM_CONC.giapImportCount.textContent = count;
    DOM_CONC.importGiapBtn.disabled = count === 0;
}

function clearGiapImportSelection() {
    giapItemsForImport = [];
    document.querySelectorAll('#giap-list .selected-for-import').forEach(el => el.classList.remove('selected-for-import'));
    updateImportButton();
}


// --- LISTENERS ---

export function setupConciliarListeners(reloadDataCallback) {
    // *** CORREÇÃO: patrimonioFullList removido deste escopo ***

    // Lógica para abas (sub-navegação está no orquestrador)
    
    // Popula unidades ao mudar o tipo (Unidade)
    DOM_CONC.conciliarFilterTipo.addEventListener('change', () => {
        // *** CORREÇÃO: Obtém estado atualizado AQUI DENTRO ***
        const { reconciledUnits, patrimonioFullList } = getState();
        const selectedTipo = DOM_CONC.conciliarFilterTipo.value;
        
        // Filtra unidades que NÃO estão na lista de 'reconciledUnits'
        const unidades = [...new Set(patrimonioFullList
            .filter(i => !reconciledUnits.includes(i.Unidade)) 
            .filter(i => !selectedTipo || normalizeStr(i.Tipo) === normalizeStr(selectedTipo))
            .map(i => i.Unidade).filter(Boolean))].sort();
            
        DOM_CONC.conciliarFilterUnidade.innerHTML = '<option value="">Selecione uma Unidade</option>' + unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        DOM_CONC.conciliarFilterUnidade.disabled = !selectedTipo;
    });

    // Carregar dados de conciliação (Unidade)
    DOM_CONC.loadConciliarBtn.addEventListener('click', () => {
        const { unitMapping, reconciledUnits } = getState();
        const selectedUnit = DOM_CONC.conciliarFilterUnidade.value;

        if (!selectedUnit) {
            showNotification('Por favor, selecione um tipo e uma unidade.', 'warning');
            return;
        }
        
        const isUnitReconciled = (reconciledUnits || []).includes(selectedUnit);
        DOM_CONC.unitReconciledWarning.classList.toggle('hidden', !isUnitReconciled);
        if (isUnitReconciled) {
             DOM_CONC.unitReconciledWarning.textContent = 'Atenção: Esta unidade já foi marcada como "Concluída". Os itens restantes são sobras ou ainda não foram vinculados. Use a aba "Conciliar com Sobras".';
        }

        // const giapUnitsForSystemUnit = (unitMapping && unitMapping[selectedUnit]) ? unitMapping[selectedUnit] : []; // Removido
        // DOM_CONC.giapListUnitName.textContent = giapUnitsForSystemUnit.join(', ') || 'Nenhuma unidade GIAP ligada'; // Removido
        
        renderConciliationLists('unidade');
            
        DOM_CONC.quickActions.classList.remove('hidden');
        selSys = null; selGiap = null; linksToCreate = []; DOM_CONC.createdLinks.innerHTML = '';
        clearGiapImportSelection();
    });
    
    // Filtros das listas (Unidade)
    DOM_CONC.systemListFilter.addEventListener('input', debounce(() => renderConciliationLists('unidade'), 300));
    DOM_CONC.giapListFilter.addEventListener('input', debounce(() => renderConciliationLists('unidade'), 300));

    // Salvar Vínculos (Unidade)
    DOM_CONC.saveLinksBtn.addEventListener('click', async () => {
        const success = await savePendingLinks('unidade', reloadDataCallback);
        if (success) {
            renderConciliationLists('unidade');
        }
    });
    
    // Limpar Seleções (Unidade)
    DOM_CONC.clearSelectionsBtn.addEventListener('click', () => {
        selSys = selGiap = null;
        document.querySelectorAll('#system-list .selected, #giap-list .selected').forEach(el => el.classList.remove('selected'));
        showNotification('Seleções limpas.', 'info');
    });

    // Finalizar Unidade (Unidade)
    DOM_CONC.finishReconciliationBtn.addEventListener('click', async () => {
        const { reconciledUnits } = getState();
        const unidade = DOM_CONC.conciliarFilterUnidade.value.trim();
        if (!unidade) return;

        const success = await savePendingLinks('unidade', reloadDataCallback);
        if (success) {
            showOverlay('Finalizando unidade...');
            if (!reconciledUnits.includes(unidade)) {
                const newReconciledUnits = [...reconciledUnits, unidade];
                try {
                    await setDoc(doc(db, 'config', 'reconciledUnits'), { units: newReconciledUnits });
                    setState({ reconciledUnits: newReconciledUnits });
                    showNotification(`Unidade "${unidade}" marcada como finalizada.`, 'info');
                    
                    DOM_CONC.conciliarFilterTipo.dispatchEvent(new Event('change'));
                } catch (error) {
                    hideOverlay();
                    showNotification('Erro ao salvar o estado da unidade.', 'error');
                    console.error(error);
                    return;
                }
            }
            DOM_CONC.systemList.innerHTML = '';
            DOM_CONC.giapList.innerHTML = '';
            DOM_CONC.quickActions.classList.add('hidden');
            hideOverlay();
        }
    });

            // Importar itens do GIAP (Unidade)
    DOM_CONC.importGiapBtn.addEventListener('click', async () => {
        if (giapItemsForImport.length === 0) return showNotification('Nenhum item GIAP selecionado para importar.', 'warning');
        
        const tipo = DOM_CONC.conciliarFilterTipo.value;
        const unidade = DOM_CONC.conciliarFilterUnidade.value;
        if (!unidade || !tipo) return showNotification('Por favor, carregue uma unidade primeiro antes de importar.', 'warning');
        
        const estado = DOM_CONC.importEstadoSelect.value;

        showOverlay(`Importando ${giapItemsForImport.length} itens...`);
        const batch = writeBatch(db);
        const newItemsForCache = [];

        giapItemsForImport.forEach(giapItem => {
            const newItemRef = doc(collection(db, 'patrimonio'));
            const newItem = {
                id: newItemRef.id,
                Tombamento: giapItem.TOMBAMENTO || '', Descrição: giapItem.Descrição || giapItem.Espécie || '',
                Tipo: tipo, Unidade: unidade, Localização: '',
                Fornecedor: giapItem['Nome Fornecedor'] || '', NF: giapItem.NF || '', 'Origem da Doação': '',
                Estado: estado, Quantidade: 1, Observação: `Importado do GIAP. Unidade original: ${giapItem.Unidade || 'N/A'}`,
                etiquetaPendente: true, isPermuta: false,
                createdAt: serverT(), updatedAt: serverT()
            };
            batch.set(newItemRef, newItem);
            newItemsForCache.push(newItem);
        });

        try {
            await batch.commit();
            
            // Atualiza o cache do IndexedDB
            await idb.patrimonio.bulkAdd(newItemsForCache);

            showNotification(`${giapItemsForImport.length} itens importados com sucesso! Atualizando...`, 'success');
            clearGiapImportSelection();
            
            // Força o reload completo no orquestrador
            reloadDataCallback(); 
            renderConciliationLists('unidade');
            // hideOverlay(); // Movido para dentro do savePendingLinks
        } catch (e) {
            hideOverlay();
            showNotification('Erro ao importar itens.', 'error'); 
            console.error(e);
        }
    });
    
    // Excluir link pendente (Unidade e Sobras)
    DOM_CONC.createdLinks.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-link-btn');
        if (!deleteBtn) return;
        
        const index = parseInt(deleteBtn.dataset.index, 10);
        const removedLink = linksToCreate.splice(index, 1)[0];

        if (removedLink) {
            renderConciliationLists('unidade');
        }
        renderCreatedLinks('unidade');
        showNotification('Vínculo removido.', 'info');
    });
    DOM_CONC.sobrasCreatedLinks.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-link-btn');
        if (!deleteBtn) return;
        const index = parseInt(deleteBtn.dataset.index, 10);
        linksToCreate.splice(index, 1);
        renderCreatedLinks('sobras');
        renderConciliationLists('sobras'); 
        showNotification('Vínculo removido.', 'info');
    });


    // --- LISTENERS MODAL DE DESCRIÇÃO ---
    DOM_CONC.descChoiceCancelBtn.addEventListener('click', () => {
        selSys = selGiap = null;
        document.querySelectorAll('.reconciliation-list-item.selected').forEach(el => el.classList.remove('selected'));
        closeDescriptionChoiceModal();
    });
    DOM_CONC.descChoiceKeepBtn.addEventListener('click', () => {
        const context = document.getElementById('subtab-conciliar-sobras').classList.contains('hidden') ? 'unidade' : 'sobras';
        addLinkToCreate(false, context); // Manter descrição do sistema
        closeDescriptionChoiceModal();
    });
    DOM_CONC.descChoiceUpdateBtn.addEventListener('click', () => {
        const context = document.getElementById('subtab-conciliar-sobras').classList.contains('hidden') ? 'unidade' : 'sobras';
        addLinkToCreate(true, context); // Usar descrição do GIAP
        closeDescriptionChoiceModal();
    });


    // --- LISTENERS PARA SUB-ABA CONCILIAR SOBRAS ---
    DOM_CONC.sobrasFilterTipo.addEventListener('change', () => {
         // *** CORREÇÃO: Obtém estado atualizado AQUI DENTRO ***
         const { patrimonioFullList } = getState();
         const selectedTipo = DOM_CONC.sobrasFilterTipo.value;
         const unitsToShow = getState().reconciledUnits.filter(unitName => {
            if (!selectedTipo) return true;
            const item = patrimonioFullList.find(i => i.Unidade === unitName);
            return item && normalizeStr(item.Tipo) === normalizeStr(selectedTipo);
        }).sort();
        
        DOM_CONC.sobrasFilterUnidade.innerHTML = '<option value="">Selecione uma Unidade</option>' + unitsToShow.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        DOM_CONC.sobrasFilterUnidade.disabled = !selectedTipo;
    });
    
    // Carregar dados (Sobras)
    DOM_CONC.loadSobrasConciliarBtn.addEventListener('click', () => {
        if (!DOM_CONC.sobrasFilterUnidade.value) { showNotification('Selecione uma unidade para carregar os itens S/T.', 'warning'); return; }
        linksToCreate = [];
        renderCreatedLinks('sobras');
        renderConciliationLists('sobras');
    });
    
    // Filtros e Salvar (Sobras)
    const debouncedRenderSobrantes = debounce(() => renderConciliationLists('sobras'), 300);
    DOM_CONC.sobrasSystemListFilter.addEventListener('input', debouncedRenderSobrantes);
    DOM_CONC.sobrasGiapListFilter.addEventListener('input', debouncedRenderSobrantes);
    DOM_CONC.sobrasGiapTypeFilter.addEventListener('change', debouncedRenderSobrantes);

    DOM_CONC.sobrasSaveLinksBtn.addEventListener('click', async () => {
        const success = await savePendingLinks('sobras', reloadDataCallback);
        if (success) {
            renderConciliationLists('sobras');
        }
    });

    DOM_CONC.sobrasClearSelectionsBtn.addEventListener('click', () => {
        selSys = selGiap = null;
        document.querySelectorAll('#sobras-system-list .selected, #sobras-giap-list .selected').forEach(el => el.classList.remove('selected'));
        showNotification('Seleções limpas.', 'info');
    });


    // --- LISTENERS PARA SUB-ABA ITENS A TOMBAR ---
    DOM_CONC.tombarFilterTipo.addEventListener('change', () => {
         // *** CORREÇÃO: Obtém estado atualizado AQUI DENTRO ***
         const { patrimonioFullList } = getState();
         const tipo = DOM_CONC.tombarFilterTipo.value;
         const unidades = [...new Set(patrimonioFullList
            .filter(i => i.etiquetaPendente === true && (!tipo || normalizeStr(i.Tipo) === normalizeStr(tipo)))
            .map(i => i.Unidade).filter(Boolean))].sort();
         DOM_CONC.tombarFilterUnidade.innerHTML = '<option value="">Todas as Unidades</option>' + unidades.map(u => `<option>${u}</option>`).join('');
         DOM_CONC.tombarFilterUnidade.disabled = false;
         renderItensATombar();
    });
    DOM_CONC.tombarFilterUnidade.addEventListener('change', renderItensATombar);
    
    DOM_CONC.itensATombarContainer.addEventListener('click', async (e) => {
        const btn = e.target.closest('.confirmar-tombamento-btn');
        if (!btn) return;
        
        // *** CORREÇÃO: Obtém estado atualizado AQUI DENTRO ***
        const { patrimonioFullList } = getState();
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = 'Salvando...';

        try {
            const docRef = doc(db, 'patrimonio', id);
            await updateDoc(docRef, { etiquetaPendente: false, updatedAt: serverT() });
            
            // Atualiza o estado em memória e cache
            const itemInInventory = patrimonioFullList.find(i => i.id === id);
            if(itemInInventory) itemInInventory.etiquetaPendente = false;
            setState({ patrimonioFullList });
            await idb.patrimonio.update(id, { etiquetaPendente: false });

            showNotification('Tombamento confirmado!', 'success');
            renderItensATombar(); // Re-renderiza a lista
        } catch (error) {
            console.error('Erro ao confirmar tombamento:', error);
            showNotification('Erro ao confirmar.', 'error');
            btn.disabled = false;
            btn.textContent = 'Confirmar Tombamento';
        }
    });
}

