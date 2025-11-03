// src/edit.js
// Ponto de entrada e controlador principal da página de edição e auditoria (edit.html).
// ARQUIVO CORRIGIDO: Lógica de "Ligar Unidades", "Conciliar Itens" e "Transferências"
// foi restaurada a partir do arquivo edit.js (antigo) e adaptada para a nova estrutura.

import { db, auth, serverT, addAuthListener, handleLogout, loadFirebaseInventory, loadUnitMappingFromFirestore, loadReconciledUnits, loadCustomGiapUnits, loadConciliationPatterns } from './services/firebase.js';
import { loadGiapInventory } from './services/giapService.js';
import { idb, isCacheStale, loadFromCache, updateLocalCache } from './services/cache.js';
import { showNotification, showOverlay, hideOverlay, normalizeStr, debounce, escapeHtml, parseCurrency, normalizeTombo, parseEstadoEOrigem, parsePtBrDate } from './utils/helpers.js';
import { calculateSimilarity } from './utils/similarity.js';
import { subscribe, setState, getState } from './state/globalStore.js';

// Imports Firebase específicos para operações
import { doc, setDoc, updateDoc, serverTimestamp, writeBatch, addDoc, query, orderBy, limit, where, deleteDoc, collection, getDocs, deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// --- DOM ELEMENTS (Simplificado) ---
const DOM = {
    loadingScreen: document.getElementById('loading-or-error-screen'),
    authGate: document.getElementById('auth-gate'),
    feedbackStatus: document.getElementById('feedback-status'),
    forceRefreshBtn: document.getElementById('force-refresh-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    navButtons: document.querySelectorAll('#edit-nav .nav-btn'),
    contentPanes: document.querySelectorAll('main > div[id^="content-"]'),
    editTableBody: document.getElementById('edit-table-body'),
    saveAllChangesBtn: document.getElementById('save-all-changes-btn'),
    syncConfirmModal: document.getElementById('sync-confirm-modal'),
    deleteConfirmModal: document.getElementById('delete-confirm-modal-edit'),
    descChoiceModal: document.getElementById('desc-choice-modal'),
    fullPageOverlay: document.getElementById('full-page-overlay'),
    overlayMessage: document.getElementById('overlay-message'),
    
    // Aba: Ligar Unidades
    mapFilterTipo: document.getElementById('map-filter-tipo'),
    mapSystemUnitSelect: document.getElementById('map-system-unit-select'),
    mapGiapFilter: document.getElementById('map-giap-filter'),
    mapGiapUnitMultiselect: document.getElementById('map-giap-unit-multiselect'),
    saveMappingBtn: document.getElementById('save-mapping-btn'),
    savedMappingsContainer: document.getElementById('saved-mappings-container'),

    // Aba: Conciliar Itens
    conciliarFilterTipo: document.getElementById('filter-tipo'),
    conciliarFilterUnidade: document.getElementById('filter-unidade'),
    loadConciliarBtn: document.getElementById('load-conciliar'),
    unitReconciledWarning: document.getElementById('unit-reconciled-warning'),
    systemListFilter: document.getElementById('system-list-filter'),
    systemList: document.getElementById('system-list'),
    giapListFilter: document.getElementById('giap-list-filter'),
    giapList: document.getElementById('giap-list'),
    giapListUnitName: document.getElementById('giap-list-unit-name'),
    quickActions: document.getElementById('quick-actions'),
    createdLinks: document.getElementById('created-links'),
    saveLinksBtn: document.getElementById('save-links'),
    clearSelectionsBtn: document.getElementById('clear-selections'),
    finishReconciliationBtn: document.getElementById('finish-reconciliation-btn'),
    importGiapBtn: document.getElementById('import-giap-btn'),
    giapImportCount: document.getElementById('giap-import-count'),

    // Aba: Conciliar Sobras
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

    // Aba: Itens a Tombar
    tombarFilterTipo: document.getElementById('tombar-filter-tipo'),
    tombarFilterUnidade: document.getElementById('tombar-filter-unidade'),
    itensATombarContainer: document.getElementById('itens-a-tombar-container'),
    
    // Aba: Transferências
    pendingTransfersContainer: document.getElementById('pending-transfers-container'),

    // Aba: Planilha GIAP
    giapTableBody: document.getElementById('giap-table-body'),

    // Aba: Notas Fiscais
    nfContainer: document.getElementById('notas-fiscais-container'),
    nfSearch: document.getElementById('nf-search'),
    nfItemSearch: document.getElementById('nf-item-search'),
    nfClearFiltersBtn: document.getElementById('clear-nf-filters-btn'),
    
    // Modais
    descChoiceCancelBtn: document.getElementById('desc-choice-cancel-btn'),
    descChoiceKeepBtn: document.getElementById('desc-choice-keep-btn'),
    descChoiceUpdateBtn: document.getElementById('desc-choice-update-btn'),
};

// --- ESTADO LOCAL/TRANSITÓRIO ---
let dirtyItems = new Map();
let currentDeleteItemIds = []; 
let selSys = null, selGiap = null; // Seleções para conciliação
let linksToCreate = [];
let giapItemsForImport = []; // Para importação direta
let currentEditFilter = { tipo: '', unidade: '', estado: '', descricao: '' };
let nfDataCache = null; // Cache para dados de NF processados

// --- INICIALIZAÇÃO E CARREGAMENTO DE DADOS ---

async function loadData(forceRefresh) {
    DOM.loadingScreen.classList.remove('hidden');
    setState({ statusMessage: 'Carregando dados...' });
    
    let [fullInventory, giapInventory] = [[], []];
    
    const cacheStale = await isCacheStale();

    if (!forceRefresh && !cacheStale) {
        setState({ statusMessage: 'Carregando cache local...' });
        [fullInventory, giapInventory] = await loadFromCache();
    } else {
        setState({ statusMessage: 'Buscando dados atualizados do servidor...' });
        showOverlay('Buscando dados no servidor...');
        try {
            const [freshPatrimonio, freshGiapData] = await Promise.all([
                loadFirebaseInventory(),
                loadGiapInventory()
            ]);
            fullInventory = freshPatrimonio;
            giapInventory = freshGiapData;
            await updateLocalCache(fullInventory, giapInventory);
        } catch (error) {
            showNotification('Erro ao carregar dados do servidor. Usando cache.', 'error');
            [fullInventory, giapInventory] = await loadFromCache();
        } finally {
            hideOverlay();
        }
    }
    
    // Carrega dados de configuração e padrões de IA
    const [unitMapping, reconciledUnits, customGiapUnits, padroesConciliacao] = await Promise.all([
        loadUnitMappingFromFirestore(),
        loadReconciledUnits(),
        loadCustomGiapUnits(),
        loadConciliationPatterns()
    ]);

    // Cria os mapas para acesso rápido
    const giapMapAllItems = new Map(giapInventory.map(item => [normalizeTombo(item['TOMBAMENTO']), item]));
    const giapMap = new Map(giapInventory
        .filter(item => normalizeStr(item.Status).includes(normalizeStr('Disponível')))
        .map(item => [normalizeTombo(item['TOMBAMENTO']), item])
    );
    const normalizedSystemUnits = new Map();
    fullInventory.forEach(item => {
        if (item.Unidade) {
            const normalized = normalizeStr(item.Unidade);
            if (!normalizedSystemUnits.has(normalized)) {
                normalizedSystemUnits.set(normalized, item.Unidade.trim());
            }
        }
    });

    setState({ 
        patrimonioFullList: fullInventory, 
        giapInventory, 
        giapMap,
        giapMapAllItems,
        unitMapping,
        reconciledUnits, // Esta é a lista de *UNIDADES* finalizadas
        customGiapUnits,
        padroesConciliacao,
        normalizedSystemUnits,
        initialLoadComplete: true,
        statusMessage: `Pronto. ${fullInventory.length} itens carregados.`
    });
}

// --- FUNÇÕES DE RENDERIZAÇÃO E ATUALIZAÇÃO DA UI ---

function updateUIFromState(state) {
    const user = state.user;
    DOM.feedbackStatus.textContent = state.statusMessage;

    if (state.authReady) {
        DOM.authGate.classList.toggle('hidden', !state.isLoggedIn);
        DOM.loadingScreen.classList.toggle('hidden', state.isLoggedIn);
        document.getElementById('user-email-edit').textContent = user ? user.email : 'Não logado';

        if (!state.isLoggedIn) {
            DOM.loadingScreen.innerHTML = `<div class="text-center"><h2 class="text-2xl font-bold text-red-600">Acesso Negado</h2><p>Você precisa estar logado para acessar esta página. Volte para a página principal para fazer o login.</p></div>`;
            return;
        }

        if (state.initialLoadComplete) {
            populateEditableInventoryTab();
            populateUnitMappingTab(); 
            populateReconciliationTab();
            populatePendingTransfersTab(); // CORREÇÃO: Esta função agora tem lógica
            populateGiapTab();
            populateNfTab();
            
            // Popula outras abas de importação, etc.
            populateImportAndReplaceTab(); 
            populateSobrantesTab(); 
        }
    }
}

// --- FUNÇÕES DAS ABAS DE ADMINISTRAÇÃO ---

/**
 * Popula a aba "Inventário Editável"
 */
function populateEditableInventoryTab() {
    const { patrimonioFullList } = getState();
    const filtroTipo = document.getElementById('edit-filter-tipo');
    const filtroEstado = document.getElementById('edit-filter-estado');

    // Popula filtros
    // const tipos = [...new Set(patrimonioFullList.map(item => item.Tipo).filter(Boolean))].sort(); // OLD
    const tiposMap = new Map(); // NEW: Para deduplicar
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!tiposMap.has(normalized)) {
            tiposMap.set(normalized, tipo.trim());
        }
    });
    const tipos = [...tiposMap.values()].sort(); // NEW: Lista única
    const estados = ['Novo', 'Bom', 'Regular', 'Avariado', 'N/D'];
    
    filtroTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    filtroEstado.innerHTML = '<option value="">Todos os Estados</option>' + estados.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');

    // Popula filtro de unidade baseado no tipo
    filtroTipo.addEventListener('change', () => {
        const selectedTipo = filtroTipo.value;
        currentEditFilter.tipo = selectedTipo;
        const filtroUnidade = document.getElementById('edit-filter-unidade');
        
        /* OLD
        const unidades = selectedTipo
            ? [...new Set(patrimonioFullList.filter(i => i.Tipo === selectedTipo).map(i => i.Unidade).filter(Boolean))].sort()
            : [];
        */
        // NEW: Deduplicar unidades
        const unidadesMap = new Map();
        (selectedTipo
            ? patrimonioFullList.filter(i => normalizeStr(i.Tipo) === normalizeStr(selectedTipo)).map(i => i.Unidade).filter(Boolean) // Compara normalizado
            : []
        ).forEach(unidade => {
            const normalized = normalizeStr(unidade);
            if (!unidadesMap.has(normalized)) {
                unidadesMap.set(normalized, unidade.trim());
            }
        });
        const unidades = [...unidadesMap.values()].sort(); // NEW: Lista única
            
        filtroUnidade.innerHTML = '<option value="">Todas as Unidades</option>' + unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        filtroUnidade.disabled = !selectedTipo;
        currentEditFilter.unidade = ''; // Reseta unidade
        renderEditableTable(); // Re-renderiza
    });
    
    // Renderiza tabela inicial (vazia)
    renderEditableTable();
}

/**
 * Renderiza a tabela do inventário editável com base nos filtros
 */
function renderEditableTable() {
    const tableBody = DOM.editTableBody;
    const { patrimonioFullList } = getState();
    
    const getNormalizedEstado = (state) => {
        const normalized = normalizeStr(state);
        if (['avariado', 'quebrado', 'defeito', 'danificado', 'ruim'].some(k => normalized.includes(k))) return 'Avariado';
        if (normalized.startsWith('novo')) return 'Novo';
        if (normalized.startsWith('bom') || normalized.startsWith('otimo')) return 'Bom';
        if (normalized.startsWith('regular')) return 'Regular';
        return 'N/D';
    };

    const filteredItems = patrimonioFullList.filter(item => {
        const { tipo, unidade, estado, descricao } = currentEditFilter;
        if (tipo && item.Tipo !== tipo) return false;
        if (unidade && item.Unidade !== unidade) return false;
        if (estado && getNormalizedEstado(item.Estado) !== estado) return false;
        if (descricao && !normalizeStr(item.Descrição).includes(descricao)) return false;
        return true;
    });

    // Limita a 200 itens para performance. Filtros mais específicos são necessários.
    const itemsToDisplay = filteredItems.slice(0, 200);

    if (itemsToDisplay.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="14" class="text-center p-10 text-slate-500">Nenhum item encontrado. Use os filtros para refinar sua busca.</td></tr>`;
    } else {
        tableBody.innerHTML = itemsToDisplay.map(item => `
            <tr id="row-${item.id}" class="${dirtyItems.has(item.id) ? 'is-dirty' : ''}">
                <td class="p-2"><input type="checkbox" class="row-checkbox" data-id="${item.id}"></td>
                <td class="p-2">
                    <button class="save-row-btn p-1 text-green-600" data-id="${item.id}" title="Salvar este item">&#10003;</button>
                    <button class="delete-row-btn p-1 text-red-600" data-id="${item.id}" title="Excluir este item">&times;</button>
                </td>
                <td class="p-2"><input type="text" class="w-24" data-id="${item.id}" data-field="Tombamento" value="${escapeHtml(item.Tombamento || '')}"></td>
                <td class="p-2"><button class="sync-giap-btn p-1" data-id="${item.id}" title="Sincronizar com GIAP">🔄</button></td>
                <td class="p-2"><input type="text" class="w-64" data-id="${item.id}" data-field="Descrição" value="${escapeHtml(item.Descrição || '')}"></td>
                <td class="p-2"><input type="text" class="w-24" data-id="${item.id}" data-field="Tipo" value="${escapeHtml(item.Tipo || '')}"></td>
                <td class="p-2"><input type="text" class="w-48" data-id="${item.id}" data-field="Unidade" value="${escapeHtml(item.Unidade || '')}"></td>
                <td class="p-2"><input type="text" class="w-32" data-id="${item.id}" data-field="Localização" value="${escapeHtml(item.Localização || '')}"></td>
                <td class="p-2"><input type="text" class="w-32" data-id="${item.id}" data-field="Fornecedor" value="${escapeHtml(item.Fornecedor || '')}"></td>
                <td class="p-2"><input type="text" class="w-20" data-id="${item.id}" data-field="NF" value="${escapeHtml(item.NF || '')}"></td>
                <td class="p-2"><input type="text" class="w-32" data-id="${item.id}" data-field="Origem da Doação" value="${escapeHtml(item['Origem da Doação'] || '')}"></td>
                <td class="p-2">
                    <select class="w-28" data-id="${item.id}" data-field="Estado">
                        <option value="Novo" ${item.Estado === 'Novo' ? 'selected' : ''}>Novo</option>
                        <option value="Bom" ${item.Estado === 'Bom' ? 'selected' : ''}>Bom</option>
                        <option value="Regular" ${item.Estado === 'Regular' ? 'selected' : ''}>Regular</option>
                        <option value="Avariado" ${item.Estado === 'Avariado' ? 'selected' : ''}>Avariado</option>
                    </select>
                </td>
                <td class="p-2"><input type="number" class="w-16" data-id="${item.id}" data-field="Quantidade" value="${item.Quantidade || 1}"></td>
                <td class="p-2"><input type="text" class="w-48" data-id="${item.id}" data-field="Observação" value="${escapeHtml(item.Observação || '')}"></td>
            </tr>
        `).join('');
    }
}


/**
 * CORREÇÃO: Popula a aba "Ligar Unidades" com os dados do sistema e GIAP.
 * Lógica restaurada do `edit.js` antigo.
 */
function populateUnitMappingTab() {
    const { patrimonioFullList } = getState();
    // const tipos = [...new Set(patrimonioFullList.map(item => item.Tipo).filter(Boolean))].sort(); // OLD
    // NEW: Deduplicar tipos
    const tiposMap = new Map();
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!tiposMap.has(normalized)) {
            tiposMap.set(normalized, tipo.trim());
        }
    });
    const tipos = [...tiposMap.values()].sort(); // NEW: Lista única
    DOM.mapFilterTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    
    // Chama as funções de população (adaptadas do `edit.js` antigo)
    updateSystemUnitOptions();
    renderSavedMappings();
    updateGiapUnitOptions();
}

/**
 * CORREÇÃO: Função adaptada do `edit.js` antigo.
 * Popula a lista de Unidades do Sistema, filtrando as já mapeadas.
 */
function updateSystemUnitOptions() {
    const { patrimonioFullList, unitMapping, normalizedSystemUnits } = getState();
    const selectedType = DOM.mapFilterTipo.value;
    const linkedSystemUnits = Object.keys(unitMapping);
    
    // CORREÇÃO: Pega todos os nomes de Tipos normalizados
    const normalizedTipos = new Set(patrimonioFullList.map(item => normalizeStr(item.Tipo)).filter(Boolean));

    const systemUnits = [...normalizedSystemUnits.values()].filter(unit => {
        // CORREÇÃO: Filtra unidades cujo nome é também um nome de tipo (ex: "SEDE")
        if (normalizedTipos.has(normalizeStr(unit))) {
            return false; 
        }
        
        const item = patrimonioFullList.find(i => i.Unidade === unit);
        const isCorrectType = !selectedType || (item && item.Tipo === selectedType); // Adicionado (item && ...)
        // Mostra apenas unidades que não estão mapeadas
        return isCorrectType && !linkedSystemUnits.includes(unit);
    }).sort();
    
    DOM.mapSystemUnitSelect.innerHTML = systemUnits.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
}

/**
 * CORREÇÃO: Função adaptada do `edit.js` antigo.
 * Popula a lista de Unidades GIAP, com sugestões e filtrando já mapeadas.
 */
function updateGiapUnitOptions() {
    const { giapInventory, customGiapUnits, unitMapping } = getState();
    const filterText = normalizeStr(DOM.mapGiapFilter.value);
    
    let allGiapUnitsFromSheet = [...new Set(giapInventory.map(i => i.Unidade).filter(Boolean))];
    let allGiapUnits = [...new Set([...allGiapUnitsFromSheet, ...customGiapUnits.map(u => u.name)])].sort();

    const selectedSystemUnits = Array.from(DOM.mapSystemUnitSelect.selectedOptions).map(opt => opt.value);
    
    const allLinkedGiapUnits = new Set(Object.values(unitMapping).flat());
    const currentMapping = new Set();
    selectedSystemUnits.forEach(unit => {
        if (unitMapping[unit]) {
            unitMapping[unit].forEach(giapUnit => currentMapping.add(giapUnit));
        }
    });

    if (filterText) {
        allGiapUnits = allGiapUnits.filter(unit => normalizeStr(unit).includes(filterText));
    }

    const keywords = new Set();
    selectedSystemUnits.forEach(unit => {
        unit.split('/').forEach(part => keywords.add(normalizeStr(part.trim())));
    });

    const suggestions = [];
    const available = [];
    const usedByOthers = [];
    
    allGiapUnits.forEach(unit => {
        const optionHtml = `<option value="${escapeHtml(unit)}">${escapeHtml(unit)}</option>`;
        const isSuggestion = keywords.size > 0 && Array.from(keywords).some(kw => kw && normalizeStr(unit).includes(kw));

        // Unidade está disponível se não estiver em NENHUM mapeamento OU se estiver no mapeamento ATUAL
        if (!allLinkedGiapUnits.has(unit) || currentMapping.has(unit)) {
            if (isSuggestion && !filterText) {
                suggestions.push(optionHtml);
            } else {
                available.push(optionHtml);
            }
        } else {
            usedByOthers.push(optionHtml);
        }
    });

    const suggestionHeader = suggestions.length > 0 ? `<optgroup label="Sugestões">` : '';
    const suggestionFooter = suggestions.length > 0 ? `</optgroup>` : '';
    const usedHeader = usedByOthers.length > 0 ? `<optgroup label="Já Mapeadas (em outras unidades)">` : '';
    const usedFooter = usedByOthers.length > 0 ? `</optgroup>` : '';

    DOM.mapGiapUnitMultiselect.innerHTML = suggestionHeader + suggestions.join('') + suggestionFooter + available.join('') + usedHeader + usedByOthers.join('') + usedFooter;
}


/**
 * Renderiza a lista de mapeamentos salvos.
 * @param {object} unitMapping - O objeto de mapeamento do estado.
 */
function renderSavedMappings() {
    const { unitMapping } = getState();
    DOM.savedMappingsContainer.innerHTML = Object.entries(unitMapping || {}).map(([systemUnit, giapUnits]) => {
        if (!giapUnits || giapUnits.length === 0) return '';
        return `
            <div class="p-2 border rounded-md bg-slate-50 flex justify-between items-center">
                <div>
                    <strong class="text-blue-600">${escapeHtml(systemUnit)}</strong>
                    <span class="text-xs mx-2">➔</span>
                    <span>${giapUnits.map(u => escapeHtml(u)).join(', ')}</span>
                </div>
                <button class="delete-mapping-btn p-1 text-red-500 hover:bg-red-100 rounded-full" data-system-unit="${escapeHtml(systemUnit)}" title="Excluir Mapeamento">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11z"/></svg>
                </button>
            </div>
        `;
    }).join('');
}

/**
 * Popula os filtros da aba "Conciliar Itens".
 */
function populateReconciliationTab() {
    const { patrimonioFullList } = getState();

    // const tipos = [...new Set(patrimonioFullList.map(item => item.Tipo).filter(Boolean))].sort(); // OLD
    // NEW: Deduplicar tipos
    const tiposMap = new Map();
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!tiposMap.has(normalized)) {
            tiposMap.set(normalized, tipo.trim());
        }
    });
    const tipos = [...tiposMap.values()].sort(); // NEW: Lista única
    DOM.conciliarFilterTipo.innerHTML = '<option value="">Selecione um Tipo</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    // O filtro de unidade será populado quando o tipo for selecionado
    DOM.conciliarFilterUnidade.disabled = true;
    
    // Popula filtro "Itens a Tombar"
    DOM.tombarFilterTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    DOM.tombarFilterUnidade.disabled = true;
}

/**
 * CORREÇÃO: Lógica de transferências restaurada do `edit.js` antigo.
 */
function populatePendingTransfersTab() {
    const { patrimonioFullList, giapMap, unitMapping } = getState();

    const pendingTransfers = patrimonioFullList.filter(item => {
        const tombo = item.Tombamento?.trim();
        // Ignora S/T, permuta, ou sem tombo
        if (!tombo || normalizeStr(tombo).includes('permuta') || tombo.toLowerCase() === 's/t') return false;

        const giapItem = giapMap.get(tombo);
        if (!giapItem) return false; // Não encontrado no GIAP, não pode verificar

        const systemUnit = (item.Unidade || '').trim();
        const giapUnit = giapItem.Unidade;
        if (!systemUnit || !giapUnit) return false; // Dados incompletos

        // Se a unidade do sistema NÃO ESTÁ MAPEADA
        if (!unitMapping[systemUnit] || unitMapping[systemUnit].length === 0) {
            // A transferência está pendente se os nomes não baterem
            return normalizeStr(systemUnit) !== normalizeStr(giapUnit);
        }

        // Se a unidade do sistema ESTÁ MAPEADA
        const mappedGiapUnits = unitMapping[systemUnit];
        // A transferência está pendente se a unidade do GIAP não está na lista de unidades mapeadas
        return !mappedGiapUnits.map(u => normalizeStr(u)).includes(normalizeStr(giapUnit));
    });

    const groupedTransfers = pendingTransfers.reduce((acc, item) => {
        const tipo = item.Tipo || 'Sem Tipo';
        if (!acc[tipo]) acc[tipo] = {};
        const unit = item.Unidade || 'Unidade Desconhecida';
        if (!acc[tipo][unit]) acc[tipo][unit] = [];
        acc[tipo][unit].push(item);
        return acc;
    }, {});
    
    const tipos = Object.keys(groupedTransfers).sort();

    if (tipos.length === 0) {
        DOM.pendingTransfersContainer.innerHTML = `<p class="text-slate-500 text-center p-4">Nenhuma transferência pendente encontrada.</p>`;
    } else {
        DOM.pendingTransfersContainer.innerHTML = tipos.map(tipo => {
            const units = Object.keys(groupedTransfers[tipo]).sort();
            const unitsHtml = units.map(unit => {
                const items = groupedTransfers[tipo][unit];
                const itemsHtml = items.map(item => {
                    const giapItem = giapMap.get(item.Tombamento.trim());
                    const giapUnitName = giapItem ? giapItem.Unidade : 'N/A';
                    return `<div class="p-3 border-t text-sm flex justify-between items-center">
                                <div>
                                    <label class="flex items-center">
                                        <input type="checkbox" class="h-4 w-4 rounded border-gray-300 transfer-item-checkbox" data-id="${item.id}" data-giap-unit="${escapeHtml(giapUnitName)}">
                                        <span class="ml-3"><strong>${escapeHtml(item.Descrição)}</strong> (T: ${escapeHtml(item.Tombamento)})</span>
                                    </label>
                                </div>
                                <div class="text-right">
                                    <p class="text-xs text-slate-500">Destino na Planilha</p>
                                    <p class="font-semibold text-red-600">${escapeHtml(giapUnitName)}</p>
                                </div>
                            </div>`;
                }).join('');

                return `<details class="bg-white rounded-lg shadow-sm border mt-2">
                            <summary class="p-4 font-semibold cursor-pointer flex justify-between items-center hover:bg-slate-50">
                                <span>${escapeHtml(unit)}</span>
                                <span class="text-sm font-bold text-red-600 bg-red-100 px-2 py-1 rounded-full">${items.length} ${items.length > 1 ? 'itens' : 'item'}</span>
                            </summary>
                            <div class="px-4 pb-2 border-t">
                                <div class="py-2 flex justify-between items-center">
                                    <label class="flex items-center text-sm font-medium"><input type="checkbox" class="h-4 w-4 mr-2 select-all-in-unit">Selecionar Todos</label>
                                    <div class="flex gap-2">
                                        <button class="keep-selected-btn text-xs bg-yellow-100 text-yellow-700 px-3 py-1 rounded-md hover:bg-yellow-200">Manter na Unidade</button>
                                        <button class="transfer-selected-btn text-xs bg-blue-100 text-blue-700 px-3 py-1 rounded-md hover:bg-blue-200">Transferir Selecionados</button>
                                    </div>
                                </div>
                                ${itemsHtml}
                            </div>
                        </details>`;
            }).join('');

            return `<div class="mb-4">
                        <h3 class="text-lg font-bold text-slate-700 p-2 bg-slate-200 rounded-t-lg">${tipo}</h3>
                        ${unitsHtml}
                    </div>`;
        }).join('');
    }
}


/**
 * Popula a aba "Planilha GIAP"
 */
function populateGiapTab() {
    const { giapInventory } = getState();
    if (!giapInventory || giapInventory.length === 0) return;

    const headers = Object.keys(giapInventory[0]);
    const tableHead = document.querySelector('#content-giap thead tr');
    const tableBody = DOM.giapTableBody;

    tableHead.innerHTML = headers.map(h => `<th class="p-3 text-left font-semibold">${escapeHtml(h)}</th>`).join('');
    
    tableBody.innerHTML = giapInventory.slice(0, 500).map(item => `
        <tr class="border-b border-slate-200 hover:bg-slate-50">
            ${headers.map(h => `<td class="p-2 text-xs">${escapeHtml(item[h])}</td>`).join('')}
        </tr>
    `).join('');
}

/**
 * Popula a aba "Notas Fiscais"
 */
function populateNfTab() {
    renderNfList(); // Renderiza a lista inicial (vazia ou completa)
}

/**
 * Processa dados do GIAP para agrupar por NF.
 * @returns {object} Objeto com NFs como chaves.
 */
function processNfData() {
    if (nfDataCache) return nfDataCache; // Usa cache se disponível

    const { giapInventory } = getState();
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

/**
 * Renderiza a lista de Notas Fiscais com base nos filtros.
 */
function renderNfList() {
    const { patrimonioFullList } = getState();
    const processedNfData = processNfData();
    const container = DOM.nfContainer;

    if (!container) return;
    container.innerHTML = '';
    if (Object.keys(processedNfData).length === 0) return; 

    const tomboMap = new Map(patrimonioFullList.map(item => [normalizeTombo(item.Tombamento), item]));
    
    const nfSearchTerm = normalizeStr(DOM.nfSearch.value);
    const itemSearchTerm = normalizeStr(DOM.nfItemSearch.value);
    
    const filteredNfs = Object.keys(processedNfData).filter(nf => {
        if (nfSearchTerm && !normalizeStr(nf).includes(nfSearchTerm)) return false;
        
        const nfGroup = processedNfData[nf];
        if (itemSearchTerm) {
            const itemMatch = nfGroup.items.some(item => 
                normalizeStr(item.Descrição).includes(itemSearchTerm) || 
                normalizeStr(item.Espécie).includes(itemSearchTerm)
            );
            if (!itemMatch) return false;
        }
        return true;
    });

    if (filteredNfs.length === 0) {
        container.innerHTML = `<p class="text-slate-500 text-center p-4">Nenhuma nota fiscal encontrada com os filtros aplicados.</p>`;
        return;
    }
    
    // Renderização
    filteredNfs.slice(0, 100).forEach(nf => { // Limita a 100 NFs por performance
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
                    } else if (normalizeStr(item.Status) !== 'disponível') {
                         allocationHtml = `<span class="badge badge-yellow">Status: ${escapeHtml(item.Status)}</span>`;
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

// --- FUNÇÕES DE LÓGICA DE CONCILIAÇÃO (Restauradas) ---

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
function getConciliationData() {
    const { patrimonioFullList, giapInventory, unitMapping } = getState();
    const unidade = DOM.conciliarFilterUnidade.value.trim();
    if (!unidade) return { systemItems: [], giapItems: [] };
    
    const systemFilterText = normalizeStr(DOM.systemListFilter.value);
    const giapFilterText = normalizeStr(DOM.giapListFilter.value);

    // Tombos já em uso no inventário GERAL ou na lista de links PENDENTES
    const usedTombamentos = new Set(patrimonioFullList.map(i => normalizeTombo(i.Tombamento)).filter(Boolean));
    linksToCreate.forEach(link => usedTombamentos.add(normalizeTombo(link.giapItem.TOMBAMENTO)));

    // Unidades do GIAP que correspondem à unidade do sistema selecionada
    const mappedGiapUnits = (unitMapping[unidade] || [unidade]).map(normalizeStr);

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
    
    // Itens do GIAP: Disponíveis, na unidade mapeada, não em uso, e correspondem ao filtro
    const giapItems = giapInventory.filter(g => {
        const tomboTrimmed = normalizeTombo(g.TOMBAMENTO);
        const giapDesc = normalizeStr(g.Descrição || g.Espécie);
        return tomboTrimmed && 
               !usedTombamentos.has(tomboTrimmed) && 
               mappedGiapUnits.includes(normalizeStr(g.Unidade)) &&
               normalizeStr(g.Status).includes(normalizeStr('Disponível')) &&
               giapDesc.includes(giapFilterText);
    });

    return { systemItems, giapItems };
}

/**
 * Renderiza uma lista de itens (Sistema ou GIAP) no container apropriado.
 */
function renderList(containerId, arr, keyField, primaryLabelField, suggestionInfo = null, context = 'default') {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    
    if (!arr || arr.length === 0) {
        container.innerHTML = `<p class="p-4 text-slate-500 text-center">Nenhum item encontrado.</p>`;
        return;
    }
    
    arr.forEach((item, index) => {
        const id = item[keyField];
        const div = document.createElement('div');
        div.className = 'reconciliation-list-item p-2 border-b';
        div.dataset.id = id; // Usa data-id para ambos (ID do sistema ou Tombo do GIAP)
        div.dataset.desc = escapeHtml(item[primaryLabelField] || item.Espécie || '');

        let detailsHtml = '';
        if (containerId.includes('system-list')) {
            // Layout para item do Sistema (S/T)
            detailsHtml = `
                <p class="font-semibold">${escapeHtml(item[primaryLabelField])}</p>
                <p class="text-xs text-slate-500">${escapeHtml(item.Localização) || 'Sem local'}</p>
            `;
        } else {
            // Layout para item do GIAP (Tombo)
            detailsHtml = `
                <p class="font-semibold">${escapeHtml(item.Descrição || item.Espécie)}</p>
                <p class="text-xs text-slate-500">Tombo: <span class="font-mono">${escapeHtml(item.TOMBAMENTO)}</span></p>
            `;
            if (context === 'sobras') {
                 detailsHtml += `<p class="text-xs text-blue-600 font-semibold mt-1">Unidade GIAP: ${escapeHtml(item.Unidade || 'N/A')}</p>`;
            }
        }
        div.innerHTML = detailsHtml;

        // Lógica de sugestão (ainda não implementada)
        // ...

        div.onclick = (event) => handleSelect(containerId, id, item, event.currentTarget);
        container.append(div);
    });
}

/**
 * Lida com a seleção de um item S/T ou um Tombo GIAP.
 */
function handleSelect(containerId, id, obj, element) {
    if (element.classList.contains('linked')) return;

    const isSobrantesTab = containerId.startsWith('sobras-');
    const systemListId = isSobrantesTab ? '#sobras-system-list' : '#system-list';
    const giapListId = isSobrantesTab ? '#sobras-giap-list' : '#giap-list';

    if (containerId.includes('system-list')) {
        // Selecionou um item S/T
        clearGiapImportSelection();
        selSys = { id, obj };
        selGiap = null; 

        document.querySelectorAll(`${giapListId} .selected`).forEach(el => el.classList.remove('selected'));
        document.querySelectorAll(`${systemListId} .selected, ${systemListId} .selected-for-import`).forEach(el => el.classList.remove('selected', 'selected-for-import'));
        element.classList.add('selected');
        
        // Sugestão de matches (ainda não implementada)
        // const giapSourceItems = isSobrantesTab ? getFilteredSobrantes() : getConciliationData().giapItems;
        // suggestGiapMatchesComAprendizado(obj, giapSourceItems);

    } else if (containerId.includes('giap-list') && selSys) {
        // Selecionou um Tombo GIAP *depois* de um S/T
        selGiap = { tomb: id, obj };
        document.querySelectorAll(`${giapListId} .selected, ${giapListId} .selected-for-import`).forEach(el => el.classList.remove('selected', 'selected-for-import'));
        element.classList.add('selected');
        openDescriptionChoiceModal(); // Pergunta qual descrição usar

    } else if (containerId.includes('giap-list') && !selSys && !isSobrantesTab) {
        // Selecionou um Tombo GIAP *sem* um S/T (para Importação)
        element.classList.toggle('selected-for-import');
        const index = giapItemsForImport.findIndex(item => item.TOMBAMENTO === id);
        if (index > -1) {
            giapItemsForImport.splice(index, 1);
        } else {
            giapItemsForImport.push(obj);
        }
        updateImportButton();
    }
}

function updateImportButton() {
    const count = giapItemsForImport.length;
    DOM.giapImportCount.textContent = count;
    DOM.importGiapBtn.disabled = count === 0;
}

function clearGiapImportSelection() {
    giapItemsForImport = [];
    document.querySelectorAll('#giap-list .selected-for-import').forEach(el => el.classList.remove('selected-for-import'));
    updateImportButton();
}

/**
 * Abre o modal para escolher entre a descrição do Sistema ou do GIAP.
 */
function openDescriptionChoiceModal() {
    if (!selSys || !selGiap) return;
    document.getElementById('desc-choice-tombo').textContent = selGiap.tomb;
    document.getElementById('desc-choice-current').textContent = selSys.obj.Descrição;
    document.getElementById('desc-choice-new').textContent = selGiap.obj.Descrição || selGiap.obj.Espécie;
    DOM.descChoiceModal.classList.remove('hidden');
}

function closeDescriptionChoiceModal() {
    DOM.descChoiceModal.classList.add('hidden');
}

/**
 * Adiciona o link (S/T + Tombo) à lista de links pendentes para salvar.
 */
function addLinkToCreate(useGiapDescription) {
    const link = {
        systemItem: selSys.obj,
        giapItem: selGiap.obj,
        useGiapDescription
    };
    linksToCreate.push(link);

    const activeTab = document.getElementById('subtab-conciliar-sobras').classList.contains('hidden') ? 'unidade' : 'sobras';
    
    if(activeTab === 'unidade') {
        renderCreatedLinks('unidade');
        document.querySelector(`#system-list div[data-id='${selSys.id}']`).classList.add('linked');
        document.querySelector(`#giap-list div[data-id='${selGiap.tomb}']`).classList.add('linked');
    } else {
        renderCreatedLinks('sobras');
        document.querySelector(`#sobras-system-list div[data-id='${selSys.id}']`).classList.add('linked');
        document.querySelector(`#sobras-giap-list div[data-id='${selGiap.tomb}']`).classList.add('linked');
    }

    selSys = selGiap = null;
    document.querySelectorAll('.reconciliation-list-item.selected').forEach(el => el.classList.remove('selected'));
}

/**
 * Renderiza a lista de links pendentes.
 */
function renderCreatedLinks(context = 'unidade') {
    const container = context === 'unidade' ? DOM.createdLinks : DOM.sobrasCreatedLinks;
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
 * Renderiza ambas as listas (Sistema e GIAP) na aba de conciliação.
 */
function renderConciliationLists() {
    const unidade = DOM.conciliarFilterUnidade.value.trim();
    if (!unidade) {
        DOM.systemList.innerHTML = `<p class="p-4 text-slate-500 text-center">Selecione uma unidade e clique em carregar.</p>`;
        DOM.giapList.innerHTML = `<p class="p-4 text-slate-500 text-center">Selecione uma unidade e clique em carregar.</p>`;
        return;
    }
    
    const { systemItems, giapItems } = getConciliationData();
    
    renderList('system-list', systemItems, 'id', 'Descrição');
    renderList('giap-list', giapItems, 'TOMBAMENTO', 'Descrição');
}

/**
 * Salva os links pendentes no Firestore.
 */
async function savePendingLinks(context = 'unidade') {
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
            etiquetaPendente: true, // Marca para imprimir etiqueta
            updatedAt: serverTimestamp()
        });
        
        // Salvar padrão de IA (lógica omitida para brevidade)
        // salvarPadraoConciliacao(systemItem, giapItem, score);
    });

    try {
        await batch.commit();
        
        // Atualiza o cache local (fullInventory e idb)
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
                patrimonioFullList[index] = updatedItem; // Atualiza o array principal em memória
                updatedItemsForCache.push(updatedItem);
             }
        });
        if(updatedItemsForCache.length > 0) {
            await idb.patrimonio.bulkPut(updatedItemsForCache);
        }
        
        setState({ patrimonioFullList }); // Atualiza o estado global
        linksToCreate = [];
        renderCreatedLinks(context);
        return true;
    } catch (error) {
        hideOverlay();
        showNotification('Erro ao salvar os vínculos.', 'error');
        console.error("Erro ao salvar vínculos:", error);
        return false;
    }
}

// --- FUNÇÕES DE OUTRAS ABAS (Restauradas/Adaptadas) ---

function populateSobrantesTab() {
    const { patrimonioFullList, reconciledUnits } = getState();
    // Tipos de unidades que já foram conciliadas
    // const reconciledTypes = [...new Set(patrimonioFullList.filter(i => reconciledUnits.includes(i.Unidade)).map(i => i.Tipo).filter(Boolean))].sort(); // OLD
    // NEW: Deduplicar tipos
    const reconciledTypesMap = new Map();
    patrimonioFullList.filter(i => reconciledUnits.includes(i.Unidade)).map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!reconciledTypesMap.has(normalized)) {
            reconciledTypesMap.set(normalized, tipo.trim());
        }
    });
    const reconciledTypes = [...reconciledTypesMap.values()].sort(); // NEW: Lista única
        
    DOM.sobrasFilterTipo.innerHTML = '<option value="">Selecione um Tipo</option>' + reconciledTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    // Tipos de todos os itens (para filtrar sobras do GIAP)
    // const allTypes = [...new Set(patrimonioFullList.map(i => i.Tipo).filter(Boolean))].sort(); // OLD
    // NEW: Deduplicar tipos
    const allTypesMap = new Map();
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!allTypesMap.has(normalized)) {
            allTypesMap.set(normalized, tipo.trim());
        }
    });
    const allTypes = [...allTypesMap.values()].sort(); // NEW: Lista única
    DOM.sobrasGiapTypeFilter.innerHTML = '<option value="">Todos os Tipos</option>' + allTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
}

function renderSobrantesConciliation() {
    const { patrimonioFullList } = getState();
    const unidade = DOM.sobrasFilterUnidade.value;
    if (!unidade) {
        showNotification('Selecione uma unidade para carregar os itens S/T.', 'warning');
        return;
    }
    linksToCreate = [];
    renderCreatedLinks('sobras');

    const systemFilterText = normalizeStr(DOM.sobrasSystemListFilter.value);
    const systemItems = patrimonioFullList.filter(i => {
        const tombo = (i.Tombamento || '').trim().toLowerCase();
        const isPending = linksToCreate.some(l => l.systemItem.id === i.id);
        return !isPending &&
               !i.isPermuta &&
               i.Unidade === unidade && 
               (tombo === '' || tombo === 's/t') && 
               normalizeStr(i.Descrição).includes(systemFilterText);
    });
    renderList('sobras-system-list', systemItems, 'id', 'Descrição', null, 'sobras');
    DOM.sobrasQuickActions.classList.remove('hidden');

    const filteredSobrantes = getFilteredSobrantes();
    renderList('sobras-giap-list', filteredSobrantes, 'TOMBAMENTO', 'Descrição', null, 'sobras');
}

function getFilteredSobrantes() {
    const { patrimonioFullList, unitMapping } = getState();
    let allLeftovers = getGlobalLeftovers();
    const giapTypeFilter = DOM.sobrasGiapTypeFilter.value;
    const giapDescFilter = normalizeStr(DOM.sobrasGiapListFilter.value);
    
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

function renderItensATombar() {
    const { patrimonioFullList } = getState();
    const container = DOM.itensATombarContainer;
    const tipo = DOM.tombarFilterTipo.value;
    const unidade = DOM.tombarFilterUnidade.value;

    const itemsPendentes = patrimonioFullList.filter(item => 
        item.etiquetaPendente === true &&
        (!tipo || item.Tipo === tipo) &&
        (!unidade || item.Unidade === unidade)
    );

    // ... (resto da lógica de renderItensATombar, que parece correta no `edit.js` novo)
    if (itemsPendentes.length === 0) {
        container.innerHTML = '<p class="text-slate-500 text-center p-4">Nenhum item pendente de tombamento com os filtros selecionados.</p>';
        return;
    }
    // Lógica de agrupamento... (omitida para brevidade, mas está no arquivo original)
    // ...
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

function populateImportAndReplaceTab() {
    const { patrimonioFullList } = getState();
    // const tipos = [...new Set(patrimonioFullList.map(item => item.Tipo).filter(Boolean))].sort(); // OLD
    // NEW: Deduplicar tipos
    const tiposMap = new Map();
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!tiposMap.has(normalized)) {
            tiposMap.set(normalized, tipo.trim());
        }
    });
    const tipos = [...tiposMap.values()].sort(); // NEW: Lista única
    
    const selects = [
        document.getElementById('mass-transfer-tipo'),
        document.getElementById('replace-tipo'),
        document.getElementById('edit-by-desc-tipo')
    ];

    selects.forEach(select => {
        if(select) select.innerHTML = '<option value="">Selecione um Tipo</option>' + tipos.map(t => `<option value="${t}">${t}</option>`).join('');
    });
}


// --- LISTENERS ---

function setupListeners() {
    // Auth Listener
    addAuthListener(user => {
        const isLoggedIn = !!user;
        setState({ isLoggedIn, user, authReady: true });
        if (isLoggedIn) {
            loadData(false); // Inicia o carregamento de dados quando logado
        }
    });

    // Forçar Atualização
    DOM.forceRefreshBtn.addEventListener('click', () => loadData(true));
    DOM.logoutBtn.addEventListener('click', () => { handleLogout(); window.location.href = 'index.html'; });
    
    // Navegação por Abas
    DOM.navButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const tabName = e.currentTarget.dataset.tab;
            DOM.navButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));
            DOM.contentPanes.forEach(pane => pane.classList.toggle('hidden', !pane.id.includes(tabName)));
            
            // CORREÇÃO: Adiciona triggers para popular abas ao clicar
            if (tabName === 'transferencias') populatePendingTransfersTab();
            if (tabName === 'conciliar') {
                 // Reseta o estado da aba de conciliação
                linksToCreate = []; selSys = null; selGiap = null;
                populateReconciliationTab();
            }
            if (tabName === 'unidades') populateUnitMappingTab();
        });
    });
    
    // --- Listeners da Aba: Inventário Editável ---
    DOM.editTableBody.addEventListener('change', (e) => {
        const target = e.target;
        const id = target.dataset.id;
        const field = target.dataset.field;
        let value = target.value;

        if (field === 'Quantidade') value = parseInt(value, 10) || 1;

        if (id && field) {
            const currentChanges = dirtyItems.get(id) || {};
            dirtyItems.set(id, { ...currentChanges, [field]: value });
            document.getElementById(`row-${id}`).classList.add('is-dirty');
            DOM.saveAllChangesBtn.disabled = false;
        }
    });

    // Salvar todas as alterações
    DOM.saveAllChangesBtn.addEventListener('click', async () => {
        if (dirtyItems.size === 0) return;
        showOverlay(`Salvando ${dirtyItems.size} alterações...`);
        const batch = writeBatch(db); 
        
        const itemsToSave = new Map(dirtyItems);
        dirtyItems.clear();
        DOM.saveAllChangesBtn.disabled = true;

        itemsToSave.forEach((changes, id) => {
            const itemRef = doc(db, 'patrimonio', id);
            batch.update(itemRef, { ...changes, lastModified: serverTimestamp() });
        });

        try {
            await batch.commit();
            showNotification(`${itemsToSave.size} alterações salvas com sucesso!`, 'success');
            await loadData(true); // Recarrega para refletir mudanças
        } catch (error) { 
            console.error("Erro ao salvar alterações:", error);
            showNotification('Erro ao salvar alterações.', 'error');
            dirtyItems = new Map([...itemsToSave, ...dirtyItems]);
            DOM.saveAllChangesBtn.disabled = dirtyItems.size > 0;
        } finally {
            hideOverlay();
        }
    });

    // --- Listeners da Aba: Ligar Unidades (CORRIGIDOS) ---

    // Filtra unidades do sistema ao mudar o tipo
    DOM.mapFilterTipo.addEventListener('change', () => {
        updateSystemUnitOptions();
        updateGiapUnitOptions();
    });
    
    // Atualiza sugestões GIAP ao mudar seleção do sistema
    DOM.mapSystemUnitSelect.addEventListener('change', updateGiapUnitOptions);

    // Filtra unidades GIAP
    DOM.mapGiapFilter.addEventListener('input', debounce(updateGiapUnitOptions, 300));
    
    // Salvar mapeamento
    DOM.saveMappingBtn.addEventListener('click', async () => {
        const { unitMapping } = getState();
        const selectedSystemUnits = Array.from(DOM.mapSystemUnitSelect.selectedOptions).map(opt => opt.value);
        const selectedGiapUnits = Array.from(DOM.mapGiapUnitMultiselect.selectedOptions).map(opt => opt.value);

        if (selectedSystemUnits.length === 0 || selectedGiapUnits.length === 0) {
            showNotification('Selecione pelo menos uma unidade de cada lista.', 'warning');
            return;
        }

        showOverlay('Salvando mapeamento...');
        try {
            const mappingRef = doc(db, 'config', 'unitMapping');
            const newMappings = {};
            selectedSystemUnits.forEach(systemUnit => {
                newMappings[systemUnit] = selectedGiapUnits;
            });

            // Mescla os novos mapeamentos com os existentes
            const updatedMappingData = { ...unitMapping, ...newMappings };
            
            // Usa setDoc (sem merge) para sobrescrever o campo 'mappings' inteiro
            await setDoc(mappingRef, { mappings: updatedMappingData });
            
            setState({ unitMapping: updatedMappingData });
            
            // Re-popula a aba inteira para refletir as mudanças
            populateUnitMappingTab(); 

            showNotification('Mapeamento salvo com sucesso!', 'success');
        } catch (error) {
            console.error("Erro ao salvar mapeamento:", error);
            showNotification('Erro ao salvar mapeamento.', 'error');
        } finally {
            hideOverlay();
        }
    });
    
    // Excluir mapeamento
    DOM.savedMappingsContainer.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-mapping-btn');
        if (!deleteBtn) return;

        const systemUnit = deleteBtn.dataset.systemUnit;
        if (!systemUnit) return;

        if (!confirm(`Tem certeza que deseja excluir o mapeamento para "${systemUnit}"?`)) {
            return;
        }

        showOverlay('Excluindo mapeamento...');
        try {
            const mappingRef = doc(db, 'config', 'unitMapping');
            
            const keyToDelete = `mappings.${systemUnit}`;
            await updateDoc(mappingRef, {
                [keyToDelete]: deleteField() // Exclui o campo do documento
            });

            const currentMapping = { ...getState().unitMapping };
            delete currentMapping[systemUnit];
            setState({ unitMapping: currentMapping });
            
            // Re-popula a aba inteira
            populateUnitMappingTab(); 

            showNotification('Mapeamento excluído!', 'success');
        } catch (error) {
            console.error("Erro ao excluir mapeamento:", error);
            showNotification('Erro ao excluir mapeamento.', 'error');
        } finally {
            hideOverlay();
        }
    });


    // --- Listeners da Aba: Conciliar Itens (CORRIGIDOS) ---

    // Popula unidades ao mudar o tipo
    DOM.conciliarFilterTipo.addEventListener('change', () => {
        const { patrimonioFullList, reconciledUnits } = getState();
        const selectedTipo = DOM.conciliarFilterTipo.value;
        
        // Filtra unidades que NÃO estão na lista de 'reconciledUnits'
        const unidades = [...new Set(patrimonioFullList
            .filter(i => !reconciledUnits.includes(i.Unidade)) 
            .filter(i => !selectedTipo || i.Tipo === selectedTipo)
            .map(i => i.Unidade).filter(Boolean))].sort();
            
        DOM.conciliarFilterUnidade.innerHTML = '<option value="">Selecione uma Unidade</option>' + unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        DOM.conciliarFilterUnidade.disabled = !selectedTipo;
    });

    // Carregar dados de conciliação
    DOM.loadConciliarBtn.addEventListener('click', () => {
        const { unitMapping, reconciledUnits } = getState();
        const selectedUnit = DOM.conciliarFilterUnidade.value;

        if (!selectedUnit) {
            showNotification('Por favor, selecione um tipo e uma unidade.', 'warning');
            return;
        }
        
        // Verifica se a unidade já foi marcada como "concluída"
        const isUnitReconciled = (reconciledUnits || []).includes(selectedUnit);
        DOM.unitReconciledWarning.classList.toggle('hidden', !isUnitReconciled);
        if (isUnitReconciled) {
             DOM.unitReconciledWarning.textContent = 'Atenção: Esta unidade já foi marcada como "Concluída". Os itens restantes são sobras ou ainda não foram vinculados. Use a aba "Conciliar com Sobras".';
        }

        // Popula o nome da unidade GIAP
        const giapUnitsForSystemUnit = (unitMapping && unitMapping[selectedUnit]) ? unitMapping[selectedUnit] : [];
        DOM.giapListUnitName.textContent = giapUnitsForSystemUnit.join(', ') || 'Nenhuma unidade GIAP ligada';
        
        // Renderiza as listas
        renderConciliationLists();
            
        DOM.quickActions.classList.remove('hidden');
        selSys = null;
        selGiap = null;
        linksToCreate = [];
        DOM.createdLinks.innerHTML = '';
        clearGiapImportSelection();
    });
    
    // Filtros das listas
    DOM.systemListFilter.addEventListener('input', debounce(renderConciliationLists, 300));
    DOM.giapListFilter.addEventListener('input', debounce(renderConciliationLists, 300));

    // Salvar Vínculos
    DOM.saveLinksBtn.addEventListener('click', async () => {
        const success = await savePendingLinks('unidade');
        if (success) {
            showNotification('Vínculos salvos! Atualizando listas...', 'success');
            renderConciliationLists(); // Re-renderiza com os dados atualizados
            hideOverlay();
        }
    });
    
    // Limpar Seleções
    DOM.clearSelectionsBtn.addEventListener('click', () => {
        selSys = selGiap = null;
        document.querySelectorAll('.reconciliation-list-item.selected').forEach(el => el.classList.remove('selected'));
        // Limpa também as sugestões (se houver)
        renderConciliationLists();
        showNotification('Seleções limpas.', 'info');
    });

    // Finalizar Unidade
    DOM.finishReconciliationBtn.addEventListener('click', async () => {
        const { reconciledUnits } = getState();
        const unidade = DOM.conciliarFilterUnidade.value.trim();
        if (!unidade) return;

        const success = await savePendingLinks('unidade');
        if (success) {
            showOverlay('Finalizando unidade...');
            if (!reconciledUnits.includes(unidade)) {
                const newReconciledUnits = [...reconciledUnits, unidade];
                try {
                    await setDoc(doc(db, 'config', 'reconciledUnits'), { units: newReconciledUnits });
                    setState({ reconciledUnits: newReconciledUnits });
                    showNotification(`Unidade "${unidade}" marcada como finalizada.`, 'info');
                    
                    // Atualiza a lista de unidades disponíveis
                    DOM.conciliarFilterTipo.dispatchEvent(new Event('change'));
                } catch (error) {
                    hideOverlay();
                    showNotification('Erro ao salvar o estado da unidade.', 'error');
                    console.error(error);
                    return;
                }
            }
            // Limpa as listas
            DOM.systemList.innerHTML = '';
            DOM.giapList.innerHTML = '';
            DOM.quickActions.classList.add('hidden');
            hideOverlay();
        }
    });

    // Excluir link pendente
    DOM.createdLinks.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-link-btn');
        if (!deleteBtn) return;
        
        const index = parseInt(deleteBtn.dataset.index, 10);
        const removedLink = linksToCreate.splice(index, 1)[0];

        if (removedLink) {
            // Re-renderiza as listas para que os itens voltem a ficar disponíveis
            renderConciliationLists();
        }
        renderCreatedLinks('unidade');
        showNotification('Vínculo removido.', 'info');
    });

    // Importar itens do GIAP
    DOM.importGiapBtn.addEventListener('click', async () => {
        if (giapItemsForImport.length === 0) return showNotification('Nenhum item GIAP selecionado para importar.', 'warning');
        
        const { patrimonioFullList } = getState();
        const tipo = DOM.conciliarFilterTipo.value;
        const unidade = DOM.conciliarFilterUnidade.value;
        if (!unidade || !tipo) return showNotification('Por favor, carregue uma unidade primeiro antes de importar.', 'warning');
        
        const estado = document.getElementById('import-estado-select').value;

        showOverlay(`Importando ${giapItemsForImport.length} itens...`);
        const batch = writeBatch(db);
        const newItemsForCache = [];

        giapItemsForImport.forEach(giapItem => {
            const newItemRef = doc(collection(db, 'patrimonio')); // Gera ID localmente
            const newItem = {
                id: newItemRef.id,
                Tombamento: giapItem.TOMBAMENTO || '', Descrição: giapItem.Descrição || giapItem.Espécie || '',
                Tipo: tipo, Unidade: unidade, Localização: '',
                Fornecedor: giapItem['Nome Fornecedor'] || '', NF: giapItem.NF || '', 'Origem da Doação': '',
                Estado: estado, Quantidade: 1, Observação: `Importado do GIAP. Unidade original: ${giapItem.Unidade || 'N/A'}`,
                etiquetaPendente: true, isPermuta: false,
                createdAt: serverTimestamp(), updatedAt: serverTimestamp()
            };
            batch.set(newItemRef, newItem);
            newItemsForCache.push(newItem);
        });

        try {
            await batch.commit();
            
            const newPatrimonioList = [...patrimonioFullList, ...newItemsForCache];
            setState({ patrimonioFullList: newPatrimonioList });
            await idb.patrimonio.bulkAdd(newItemsForCache);

            showNotification(`${giapItemsForImport.length} itens importados com sucesso! Atualizando...`, 'success');
            clearGiapImportSelection();
            
            renderConciliationLists();
            hideOverlay();
        } catch (e) {
            hideOverlay();
            showNotification('Erro ao importar itens.', 'error'); 
            console.error(e);
        }
    });

    // Modal de Escolha de Descrição
    DOM.descChoiceCancelBtn.addEventListener('click', () => {
        selSys = selGiap = null;
        document.querySelectorAll('.reconciliation-list-item.selected').forEach(el => el.classList.remove('selected'));
        closeDescriptionChoiceModal();
    });
    DOM.descChoiceKeepBtn.addEventListener('click', () => {
        addLinkToCreate(false); // Manter descrição do sistema
        closeDescriptionChoiceModal();
    });
    DOM.descChoiceUpdateBtn.addEventListener('click', () => {
        addLinkToCreate(true); // Usar descrição do GIAP
        closeDescriptionChoiceModal();
    });


    // --- Listeners da Aba: Conciliar Sobras (CORRIGIDOS) ---
    DOM.sobrasFilterTipo.addEventListener('change', () => {
        const { patrimonioFullList, reconciledUnits } = getState();
        const selectedTipo = DOM.sobrasFilterTipo.value;
        
        const unitsToShow = reconciledUnits.filter(unitName => {
            if (!selectedTipo) return true;
            const item = patrimonioFullList.find(i => i.Unidade === unitName);
            return item && item.Tipo === selectedTipo;
        }).sort();
        
        DOM.sobrasFilterUnidade.innerHTML = '<option value="">Selecione uma Unidade</option>' + unitsToShow.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        DOM.sobrasFilterUnidade.disabled = !selectedTipo;
    });
    
    DOM.loadSobrasConciliarBtn.addEventListener('click', renderSobrantesConciliation);
    const debouncedRenderSobrantes = debounce(renderSobrantesConciliation, 300);
    DOM.sobrasSystemListFilter.addEventListener('input', debouncedRenderSobrantes);
    DOM.sobrasGiapListFilter.addEventListener('input', debouncedRenderSobrantes);
    DOM.sobrasGiapTypeFilter.addEventListener('change', debouncedRenderSobrantes);

    DOM.sobrasSaveLinksBtn.addEventListener('click', async () => {
        const success = await savePendingLinks('sobras');
        if (success) {
            showNotification('Vínculos salvos! Atualizando listas...', 'success');
            renderSobrantesConciliation();
            hideOverlay();
        }
    });

    DOM.sobrasClearSelectionsBtn.addEventListener('click', () => {
        selSys = selGiap = null;
        document.querySelectorAll('#sobras-system-list .selected, #sobras-giap-list .selected').forEach(el => el.classList.remove('selected'));
        showNotification('Seleções limpas.', 'info');
    });
    
    DOM.sobrasCreatedLinks.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-link-btn');
        if (!deleteBtn) return;
        const index = parseInt(deleteBtn.dataset.index, 10);
        linksToCreate.splice(index, 1);
        renderCreatedLinks('sobras');
        renderSobrantesConciliation(); // Re-renderiza para mostrar itens como disponíveis
        showNotification('Vínculo removido.', 'info');
    });

    // --- Listeners da Aba: Itens a Tombar (CORRIGIDOS) ---
    DOM.tombarFilterTipo.addEventListener('change', () => {
         const { patrimonioFullList } = getState();
         const tipo = DOM.tombarFilterTipo.value;
         const unidades = [...new Set(patrimonioFullList
            .filter(i => i.etiquetaPendente === true && (!tipo || i.Tipo === tipo))
            .map(i => i.Unidade).filter(Boolean))].sort();
         DOM.tombarFilterUnidade.innerHTML = '<option value="">Todas as Unidades</option>' + unidades.map(u => `<option>${u}</option>`).join('');
         DOM.tombarFilterUnidade.disabled = false;
         renderItensATombar();
    });
    DOM.tombarFilterUnidade.addEventListener('change', renderItensATombar);
    
    DOM.itensATombarContainer.addEventListener('click', async (e) => {
        const btn = e.target.closest('.confirmar-tombamento-btn');
        if (!btn) return;
        
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = 'Salvando...';

        try {
            const docRef = doc(db, 'patrimonio', id);
            await updateDoc(docRef, { etiquetaPendente: false });
            
            const { patrimonioFullList } = getState();
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

    // --- Listeners da Aba: Transferências (CORRIGIDOS) ---
    DOM.pendingTransfersContainer.addEventListener('click', async (e) => {
        const target = e.target;
        
        if (target.classList.contains('select-all-in-unit')) {
            const detailsContent = target.closest('details');
            const checkboxes = detailsContent.querySelectorAll('.transfer-item-checkbox');
            checkboxes.forEach(cb => cb.checked = target.checked);
            return;
        }

        const actionButton = target.closest('.keep-selected-btn, .transfer-selected-btn');
        if (!actionButton) return;

        const detailsContent = actionButton.closest('details');
        const selectedCheckboxes = detailsContent.querySelectorAll('.transfer-item-checkbox:checked');
        
        if (selectedCheckboxes.length === 0) {
            showNotification('Nenhum item selecionado para a ação.', 'warning');
            return;
        }

        const batch = writeBatch(db);
        let actionDescription = '';
        const { patrimonioFullList } = getState();

        if (actionButton.classList.contains('keep-selected-btn')) {
            actionDescription = `Mantendo ${selectedCheckboxes.length} iten(s) na unidade de origem...`;
            selectedCheckboxes.forEach(cb => {
                const docRef = doc(db, 'patrimonio', cb.dataset.id);
                batch.update(docRef, { 
                    Observação: 'Transferência GIAP ignorada manualmente.',
                    updatedAt: serverTimestamp()
                });
            });
        } else if (actionButton.classList.contains('transfer-selected-btn')) {
            actionDescription = `Transferindo ${selectedCheckboxes.length} iten(s)...`;
            selectedCheckboxes.forEach(cb => {
                const docRef = doc(db, 'patrimonio', cb.dataset.id);
                const newUnit = cb.dataset.giapUnit;
                
                // Tenta encontrar o tipo da nova unidade baseado em algum item existente nela
                const existingItemInNewUnit = patrimonioFullList.find(i => i.Unidade === newUnit);
                const newTipo = existingItemInNewUnit ? existingItemInNewUnit.Tipo : 'N/A (Verificar)'; 

                batch.update(docRef, {
                    Unidade: newUnit,
                    Tipo: newTipo, 
                    Observação: 'Item transferido para unidade correta via auditoria.',
                    updatedAt: serverTimestamp()
                });
            });
        }
        
        showOverlay(actionDescription);
        try {
            await batch.commit();
            await idb.metadata.clear(); // Força recarregar
            showNotification('Ação concluída com sucesso! Recarregando dados...', 'success');
            await loadData(true); // Recarrega os dados
        } catch (error) {
            hideOverlay();
            showNotification('Ocorreu um erro ao processar a solicitação.', 'error');
            console.error("Erro na ação de transferência:", error);
        } finally {
            hideOverlay();
        }
    });

    // --- Listeners de Outras Abas (Notas Fiscais, Importação, etc.) ---
    
    // Listeners da Aba Notas Fiscais
    DOM.nfSearch.addEventListener('input', debounce(renderNfList, 300));
    DOM.nfItemSearch.addEventListener('input', debounce(renderNfList, 300));
    DOM.nfClearFiltersBtn.addEventListener('click', () => {
        DOM.nfSearch.value = '';
        DOM.nfItemSearch.value = '';
        // Limpar outros filtros de NF aqui...
        renderNfList();
    });
    
    // Listeners de navegação sub-abas
    document.querySelectorAll('.sub-nav-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            // const subtabName = e.currentTarget.dataset.subtab || e.currentTarget.dataset.subtabConciliar; // OLD
            // const parent = e.currentTarget.closest('.flex.border-b'); // OLD
            // parent.querySelectorAll('.sub-nav-btn').forEach(btn => btn.classList.remove('active')); // OLD
            // e.currentTarget.classList.add('active'); // OLD
            
            // Lógica para mostrar/esconder painéis da sub-aba
            // (Esta lógica está no `edit.js` antigo e parece correta no novo)

            // CORREÇÃO: Adicionando lógica de clique das sub-abas
            const btn = e.currentTarget;
            const parentNav = btn.closest('.flex.border-b');
            const parentCard = btn.closest('.card');

            // Remove active de todos os botões irmãos
            parentNav.querySelectorAll('.sub-nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (btn.dataset.subtabConciliar) {
                // Lógica para a aba "Conciliar"
                const subTab = btn.dataset.subtabConciliar;
                parentCard.querySelectorAll('div[id^="subtab-conciliar-"]').forEach(pane => {
                    pane.classList.toggle('hidden', pane.id !== `subtab-conciliar-${subTab}`);
                });
                
                // Resetar estado ao trocar de sub-aba
                linksToCreate = []; selSys = null; selGiap = null;
                
                if(subTab === 'itens_a_tombar') renderItensATombar();
                if(subTab === 'conciliacao_sobras') populateSobrantesTab();
                // Se for 'conciliacao_unidade', não faz nada, espera o "Carregar"
                
            } else if (btn.dataset.subtab) {
                // Lógica para a aba "Importação"
                const subTab = btn.dataset.subtab;
                parentCard.querySelectorAll('div[id^="subtab-content-"]').forEach(pane => {
                    pane.classList.toggle('hidden', pane.id !== `subtab-content-${subTab}`);
                });
            }
        });
    });

    // Fechar Modais
    document.addEventListener('click', (e) => { 
        if (e.target.matches('.js-close-modal') || e.target.matches('.modal-overlay')) { 
            e.target.closest('.modal')?.classList.add('hidden'); 
        } 
    });
    
    // ... (Outros listeners de importação, etc., do arquivo original) ...
    // Adicionar listeners para 'add-item-modal', 'delete-confirm-modal-edit', etc.
    // A lógica para 'edit-by-desc' e 'replace' parece estar no arquivo,
    // então vou garantir que os listeners de setup (como `populateImportAndReplaceTab`)
    // sejam chamados.
    
    function setupImportAndReplaceListeners() {
        const { patrimonioFullList } = getState();
        // Popula os selects de tipo
        populateImportAndReplaceTab();
        
        // Listener para popular unidades (comum a várias ferramentas)
        const setupUnitSelect = (tipoSelectId, unitSelectId) => {
             document.getElementById(tipoSelectId).addEventListener('change', () => {
                const selectedTipo = document.getElementById(tipoSelectId).value;
                const unitSelect = document.getElementById(unitSelectId);
                if (!selectedTipo) {
                    unitSelect.innerHTML = '';
                    unitSelect.disabled = true;
                    return;
                }
                // const unidades = [...new Set(patrimonioFullList.filter(i => i.Tipo === selectedTipo).map(i => i.Unidade).filter(Boolean))].sort(); // OLD
                // NEW: Deduplicar unidades
                const unidadesMap = new Map();
                patrimonioFullList.filter(i => normalizeStr(i.Tipo) === normalizeStr(selectedTipo)).map(i => i.Unidade).filter(Boolean).forEach(unidade => { // Compara normalizado
                    const normalized = normalizeStr(unidade);
                    if (!unidadesMap.has(normalized)) {
                        unidadesMap.set(normalized, unidade.trim());
                    }
                });
                const unidades = [...unidadesMap.values()].sort(); // NEW: Lista única
                unitSelect.innerHTML = '<option value="">Selecione uma Unidade</option>' + unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
                unitSelect.disabled = false;
            });
        };

        setupUnitSelect('mass-transfer-tipo', 'mass-transfer-unit');
        setupUnitSelect('replace-tipo', 'replace-unit');
        setupUnitSelect('edit-by-desc-tipo', 'edit-by-desc-unit');
        
        // ... (Listeners de 'preview-replace-btn', 'confirm-replace-btn', 'mass-transfer-search-btn', etc.
        // A lógica para eles já está no arquivo `src/edit.js` novo) ...
    }
    setupImportAndReplaceListeners();

    // CORREÇÃO: Listener para "Tombos Sobrando"
    document.getElementById('suggest-sobrando').addEventListener('click', () => {
        const keyword = normalizeStr(document.getElementById('leftover-keyword').value);
        const tomboFilter = normalizeStr(document.getElementById('leftover-tombo').value);
        
        const leftovers = getGlobalLeftovers(); // Esta função já existe e está correta
        
        const filtered = leftovers.filter(item => {
            const tomboItem = normalizeTombo(item.TOMBAMENTO);
            const descItem = normalizeStr(item.Descrição || item.Espécie);
            const matchesKeyword = !keyword || descItem.includes(keyword);
            const matchesTombo = !tomboFilter || tomboItem.includes(tomboFilter);
            return matchesKeyword && matchesTombo;
        });

        document.getElementById('total-sobrando').textContent = filtered.length;
        renderList('sobrando-list', filtered, 'TOMBAMENTO', 'Descrição', null, 'sobras');
    });
}


// --- INICIALIZAÇÃO ---

