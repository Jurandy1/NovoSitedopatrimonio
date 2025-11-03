// src/edit.js
// Ponto de entrada e controlador principal da página de edição e auditoria (edit.html).
// Centraliza a lógica para todas as abas de administração (Edição, Mapeamento, Conciliação, etc.).

// CORREÇÃO: Adicionado 'db', 'auth' e 'serverT' à importação.
import { db, auth, serverT, addAuthListener, handleLogout, loadFirebaseInventory, loadUnitMappingFromFirestore, loadReconciledUnits, loadCustomGiapUnits, loadConciliationPatterns } from './services/firebase.js';
import { loadGiapInventory } from './services/giapService.js';
import { idb, isCacheStale, loadFromCache, updateLocalCache } from './services/cache.js';
import { showNotification, showOverlay, hideOverlay, normalizeStr, debounce, escapeHtml, parseCurrency, normalizeTombo, parseEstadoEOrigem, parsePtBrDate } from './utils/helpers.js';
import { calculateSimilarity } from './utils/similarity.js';
import { subscribe, setState, getState } from './state/globalStore.js';

// Imports Firebase específicos para operações
// CORREÇÃO: Adicionado 'deleteField' para remover mapeamentos
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
    unitReconciledWarning: document.getElementById('unit-reconciled-warning'), // CORREÇÃO: Adicionado
    systemListFilter: document.getElementById('system-list-filter'),
    systemList: document.getElementById('system-list'),
    giapListFilter: document.getElementById('giap-list-filter'),
    giapList: document.getElementById('giap-list'),
    giapListUnitName: document.getElementById('giap-list-unit-name'),
    quickActions: document.getElementById('quick-actions'),
    createdLinks: document.getElementById('created-links'),
    saveLinksBtn: document.getElementById('save-links'),
    clearSelectionsBtn: document.getElementById('clear-selections'),

    // Aba: Planilha GIAP (NOVO)
    giapTableBody: document.getElementById('giap-table-body'),

    // Aba: Notas Fiscais (NOVO)
    nfContainer: document.getElementById('notas-fiscais-container'),
    nfSearch: document.getElementById('nf-search'),
    nfItemSearch: document.getElementById('nf-item-search'),
    nfClearFiltersBtn: document.getElementById('clear-nf-filters-btn'),
};

// --- ESTADO LOCAL/TRANSITÓRIO ---
let dirtyItems = new Map();
let currentDeleteItemIds = []; 
let selSys = null, selGiap = null; // Seleções para conciliação
let linksToCreate = [];
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
        reconciledUnits,
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
            // CORREÇÃO: Chama as funções de população que agora têm código
            populateEditableInventoryTab();
            populateUnitMappingTab(); 
            populateReconciliationTab();
            populatePendingTransfersTab(); // Ainda está vazia
            
            // CORREÇÃO: Chamar as novas funções
            populateGiapTab();
            populateNfTab();
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
    const tipos = [...new Set(patrimonioFullList.map(item => item.Tipo).filter(Boolean))].sort();
    const estados = ['Novo', 'Bom', 'Regular', 'Avariado', 'N/D'];
    
    filtroTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    filtroEstado.innerHTML = '<option value="">Todos os Estados</option>' + estados.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');

    // Popula filtro de unidade baseado no tipo
    filtroTipo.addEventListener('change', () => {
        const selectedTipo = filtroTipo.value;
        currentEditFilter.tipo = selectedTipo;
        const filtroUnidade = document.getElementById('edit-filter-unidade');
        
        const unidades = selectedTipo
            ? [...new Set(patrimonioFullList.filter(i => i.Tipo === selectedTipo).map(i => i.Unidade).filter(Boolean))].sort()
            : [];
            
        filtroUnidade.innerHTML = '<option value="">Todas as Unidades</option>' + unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        filtroUnidade.disabled = !selectedTipo;
        currentEditFilter.unidade = ''; // Reseta unidade
        renderEditableTable(); // Re-renderiza
    });
    
    // Listeners de filtro
    document.getElementById('edit-filter-unidade').addEventListener('change', (e) => { currentEditFilter.unidade = e.target.value; renderEditableTable(); });
    filtroEstado.addEventListener('change', (e) => { currentEditFilter.estado = e.target.value; renderEditableTable(); });
    document.getElementById('edit-filter-descricao').addEventListener('input', debounce((e) => { currentEditFilter.descricao = normalizeStr(e.target.value); renderEditableTable(); }, 300));

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
 * Popula a aba "Ligar Unidades" com os dados do sistema e GIAP.
 */
function populateUnitMappingTab() {
    const { patrimonioFullList, giapInventory, customGiapUnits, unitMapping } = getState();

    // 1. Popula tipos de unidade do sistema (lado esquerdo)
    const tipos = [...new Set(patrimonioFullList.map(item => item.Tipo).filter(Boolean))].sort();
    DOM.mapFilterTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    // 2. Popula unidades GIAP (lado direito)
    const giapUnits = [
        ...new Set(giapInventory.map(item => item.Unidade).filter(Boolean)),
        ...customGiapUnits // Adiciona unidades customizadas
    ].sort();
    
    DOM.mapGiapUnitMultiselect.innerHTML = giapUnits.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');

    // 3. Renderiza os mapeamentos já salvos
    renderSavedMappings(unitMapping);
}

/**
 * Renderiza a lista de mapeamentos salvos.
 * @param {object} unitMapping - O objeto de mapeamento do estado.
 */
function renderSavedMappings(unitMapping) {
    // CORREÇÃO: Adicionado (unitMapping || {}) para evitar erro se unitMapping for nulo
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

    const tipos = [...new Set(patrimonioFullList.map(item => item.Tipo).filter(Boolean))].sort();
    DOM.conciliarFilterTipo.innerHTML = '<option value="">Selecione um Tipo</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    // O filtro de unidade será populado quando o tipo for selecionado
    DOM.conciliarFilterUnidade.disabled = true;
}

function populatePendingTransfersTab() { /* ... Lógica de transferências pendentes ... */ }

/**
 * CORREÇÃO: Popula a aba "Planilha GIAP"
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
 * CORREÇÃO: Popula a aba "Notas Fiscais"
 */
function populateNfTab() {
    renderNfList(); // Renderiza a lista inicial (vazia ou completa)

    // Adiciona listeners aos filtros
    const debouncedRender = debounce(renderNfList, 300);
    DOM.nfSearch.addEventListener('input', debouncedRender);
    DOM.nfItemSearch.addEventListener('input', debouncedRender);
    DOM.nfClearFiltersBtn.addEventListener('click', () => {
        DOM.nfSearch.value = '';
        DOM.nfItemSearch.value = '';
        renderNfList();
    });
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
            // Chama a renderização da aba se necessário (ex: Conciliação, Transferências)
        });
    });
    
    // --- Listeners da Aba: Inventário Editável ---
    DOM.editTableBody.addEventListener('change', (e) => {
        // ... (Lógica para marcar item como 'dirty' e salvar no estado local/transitorio)
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

    // Salvar todas as alterações (simplificado)
    DOM.saveAllChangesBtn.addEventListener('click', async () => {
        if (dirtyItems.size === 0) return;
        showOverlay(`Salvando ${dirtyItems.size} alterações...`);
        // CORREÇÃO: Usar o 'db' importado
        const batch = writeBatch(db); 
        
        const itemsToSave = new Map(dirtyItems); // Copia o map
        dirtyItems.clear(); // Limpa o original
        DOM.saveAllChangesBtn.disabled = true;

        itemsToSave.forEach((changes, id) => {
            const itemRef = doc(db, 'patrimonio', id);
            batch.update(itemRef, { ...changes, lastModified: serverTimestamp() });
        });

        try {
            await batch.commit();
            showNotification(`${itemsToSave.size} alterações salvas com sucesso!`, 'success');
            // Recarregar dados para refletir mudanças
            await loadData(true); 
        // CORREÇÃO DE SINTAXE: de 'catch (error {' para 'catch (error) {'
        } catch (error) { 
            console.error("Erro ao salvar alterações:", error);
            showNotification('Erro ao salvar alterações.', 'error');
            // Se der erro, restaura os itens que falharam
            dirtyItems = new Map([...itemsToSave, ...dirtyItems]);
            DOM.saveAllChangesBtn.disabled = dirtyItems.size > 0;
        } finally {
            hideOverlay();
        }
    });

    // --- Listeners da Aba: Ligar Unidades ---

    // Filtra unidades do sistema ao mudar o tipo
    DOM.mapFilterTipo.addEventListener('change', () => {
        const { patrimonioFullList } = getState();
        const selectedTipo = DOM.mapFilterTipo.value;
        const unidades = selectedTipo
            ? [...new Set(patrimonioFullList.filter(i => i.Tipo === selectedTipo).map(i => i.Unidade).filter(Boolean))].sort()
            : [];
        DOM.mapSystemUnitSelect.innerHTML = unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
    });

    // Filtra unidades GIAP
    DOM.mapGiapFilter.addEventListener('input', debounce(() => {
        const filterText = normalizeStr(DOM.mapGiapFilter.value);
        Array.from(DOM.mapGiapUnitMultiselect.options).forEach(option => {
            option.style.display = normalizeStr(option.text).includes(filterText) ? '' : 'none';
        });
    }, 300));
    
    // CORREÇÃO: Implementação da lógica de salvar e excluir mapeamento
    DOM.saveMappingBtn.addEventListener('click', async () => {
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

            await setDoc(mappingRef, { mappings: newMappings }, { merge: true });
            
            // Atualiza o estado local
            const updatedMapping = { ...getState().unitMapping, ...newMappings };
            setState({ unitMapping: updatedMapping });
            renderSavedMappings(updatedMapping); // Re-renderiza a lista de salvos

            showNotification('Mapeamento salvo com sucesso!', 'success');
        // CORREÇÃO DE SINTAXE: de 'catch (error {' para 'catch (error) {'
        } catch (error) {
            console.error("Erro ao salvar mapeamento:", error);
            showNotification('Erro ao salvar mapeamento.', 'error');
        } finally {
            hideOverlay();
        }
    });
    
    DOM.savedMappingsContainer.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-mapping-btn');
        if (!deleteBtn) return;

        const systemUnit = deleteBtn.dataset.systemUnit;
        if (!systemUnit) return;

        // CORREÇÃO: Usar um modal customizado ou `confirm()` (se soubermos que funciona)
        // Por segurança, vou assumir que `confirm` funciona, mas um modal seria melhor.
        if (!confirm(`Tem certeza que deseja excluir o mapeamento para "${systemUnit}"?`)) {
            return;
        }

        showOverlay('Excluindo mapeamento...');
        try {
            const mappingRef = doc(db, 'config', 'unitMapping');
            
            // Para excluir um campo, usamos updateDoc com deleteField()
            const keyToDelete = `mappings.${systemUnit}`;
            await updateDoc(mappingRef, {
                [keyToDelete]: deleteField()
            });

            // Atualiza o estado local
            const currentMapping = { ...getState().unitMapping };
            delete currentMapping[systemUnit];
            setState({ unitMapping: currentMapping });
            renderSavedMappings(currentMapping); // Re-renderiza a lista

            showNotification('Mapeamento excluído!', 'success');
        // CORREÇÃO DE SINTAXE: de 'catch (error {' para 'catch (error) {'
        } catch (error) {
            console.error("Erro ao excluir mapeamento:", error);
            showNotification('Erro ao excluir mapeamento.', 'error');
        } finally {
            hideOverlay();
        }
    });


    // --- Listeners da Aba: Conciliar Itens ---

    // Popula unidades ao mudar o tipo
    DOM.conciliarFilterTipo.addEventListener('change', () => {
        const { patrimonioFullList } = getState();
        const selectedTipo = DOM.conciliarFilterTipo.value;
        const unidades = selectedTipo
            ? [...new Set(patrimonioFullList.filter(i => i.Tipo === selectedTipo).map(i => i.Unidade).filter(Boolean))].sort()
            : [];
        DOM.conciliarFilterUnidade.innerHTML = '<option value="">Selecione uma Unidade</option>' + unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        DOM.conciliarFilterUnidade.disabled = !selectedTipo;
    });

    // CORREÇÃO: Implementação da lógica de carregar conciliação
    DOM.loadConciliarBtn.addEventListener('click', () => {
        const { patrimonioFullList, giapMap, unitMapping, reconciledUnits } = getState();
        const selectedUnit = DOM.conciliarFilterUnidade.value;

        if (!selectedUnit) {
            showNotification('Por favor, selecione um tipo e uma unidade.', 'warning');
            return;
        }
        
        const reconciled = reconciledUnits || [];

        // CORREÇÃO: Adiciona aviso se a unidade já foi conciliada
        const isUnitReconciled = reconciled.includes(selectedUnit);
        DOM.unitReconciledWarning.classList.toggle('hidden', !isUnitReconciled);
        DOM.unitReconciledWarning.textContent = 'Atenção: Esta unidade já foi marcada como "Concluída". Os itens restantes são sobras ou ainda não foram vinculados.';

        // 1. Popula Itens do Sistema (S/T)
        // Mostra apenas itens S/T que AINDA não foram vinculados (não estão em `reconciled`)
        const systemItems = patrimonioFullList.filter(item => 
            item.Unidade === selectedUnit && 
            (item.Tombamento === 'S/T' || !item.Tombamento) &&
            !reconciled.includes(item.id) // Assumindo que `reconciledUnits` armazena o ID do item S/T
        ).sort((a, b) => (a.Descrição || '').localeCompare(b.Descrição || ''));
        
        DOM.systemList.innerHTML = systemItems.length > 0
            ? systemItems.map(item => `
                <div class="reconciliation-list-item p-2 border-b" data-id="${item.id}" data-desc="${escapeHtml(item.Descrição)}">
                    <p class="font-semibold">${escapeHtml(item.Descrição)}</p>
                    <p class="text-xs text-slate-500">${escapeHtml(item.Localização) || 'Sem local'}</p>
                </div>
            `).join('')
            : '<p class="p-4 text-slate-500 text-center">Nenhum item "S/T" pendente encontrado para esta unidade.</p>';

        // 2. Popula Itens do GIAP (Disponíveis)
        const giapUnitsForSystemUnit = (unitMapping && unitMapping[selectedUnit]) ? unitMapping[selectedUnit] : [];
        DOM.giapListUnitName.textContent = giapUnitsForSystemUnit.join(', ') || 'Nenhuma unidade GIAP ligada';
        
        const giapItems = [];
        giapMap.forEach((item, tombo) => {
            // Inclui se a unidade do GIAP está mapeada para a unidade do sistema E
            // se o tombo não está na lista de "já conciliados"
            if (giapUnitsForSystemUnit.includes(item.Unidade) && !reconciled.includes(tombo)) {
                giapItems.push(item);
            }
        });
        
        giapItems.sort((a, b) => (a.Descrição || '').localeCompare(b.Descrição || ''));

        DOM.giapList.innerHTML = giapItems.length > 0
            ? giapItems.map(item => `
                <div class="reconciliation-list-item p-2 border-b" data-tombo="${escapeHtml(item.TOMBAMENTO)}" data-desc="${escapeHtml(item.Descrição)}">
                    <p class="font-semibold">${escapeHtml(item.Descrição)}</p>
                    <p class="text-xs text-slate-500">Tombo: <span class="font-mono">${escapeHtml(item.TOMBAMENTO)}</span></p>
                </div>
            `).join('')
            : '<p class="p-4 text-slate-500 text-center">Nenhum tombo disponível encontrado para as unidades GIAP ligadas.</p>';
            
        // Mostra os botões de ação
        DOM.quickActions.classList.remove('hidden');
        selSys = null;
        selGiap = null;
        linksToCreate = [];
        DOM.createdLinks.innerHTML = '';
    });


    // Fechar Modais (Overlay ou Botão genérico)
    document.addEventListener('click', (e) => { 
        if (e.target.matches('.js-close-modal') || e.target.matches('.modal-overlay')) { 
            e.target.closest('.modal')?.classList.add('hidden'); 
        } 
    });
}

// --- INICIALIZAÇÃO ---
function init() {
    // 1. Assina o Listener Global
    subscribe(updateUIFromState);

    // 2. Configura Listeners de Eventos
    setupListeners();
}

document.addEventListener('DOMContentLoaded', init);
