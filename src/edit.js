// src/edit.js
// Ponto de entrada e controlador principal da página de edição e auditoria (edit.html).
// Centraliza a lógica para todas as abas de administração (Edição, Mapeamento, Conciliação, etc.).

import { addAuthListener, handleLogout, loadFirebaseInventory, loadUnitMappingFromFirestore, loadReconciledUnits, loadCustomGiapUnits, loadConciliationPatterns } from './services/firebase.js';
import { loadGiapInventory } from './services/giapService.js';
import { idb, isCacheStale, loadFromCache, updateLocalCache } from './services/cache.js';
import { showNotification, showOverlay, hideOverlay, normalizeStr, debounce, escapeHtml, parseCurrency, normalizeTombo, parseEstadoEOrigem, parsePtBrDate } from './utils/helpers.js';
import { calculateSimilarity } from './utils/similarity.js';
import { subscribe, setState, getState } from './state/globalStore.js';

// Imports Firebase específicos para operações
import { doc, setDoc, updateDoc, serverTimestamp, writeBatch, addDoc, query, orderBy, limit, where, deleteDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


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
    // Filtros da aba de edição
    editFilterTipo: document.getElementById('edit-filter-tipo'),
    editFilterUnidade: document.getElementById('edit-filter-unidade'),
    editFilterEstado: document.getElementById('edit-filter-estado'),
    editFilterDescricao: document.getElementById('edit-filter-descricao'),
    unitItemCount: document.getElementById('unit-item-count'),
};

// --- ESTADO LOCAL/TRANSITÓRIO ---
let dirtyItems = new Map();
let currentDeleteItemIds = []; 
let selSys = null, selGiap = null; // Seleções para conciliação
let linksToCreate = [];
let patrimonioFilteredList = []; // Lista para a aba de edição

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
            console.error("Erro ao carregar dados do servidor:", error); // Adicionado log de erro
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

    // CORREÇÃO: Inicializa a lista filtrada com todos os itens
    patrimonioFilteredList = [...fullInventory];

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
            populateUnitMappingTab(); // Ainda está vazia, mas pode ser preenchida
            populateReconciliationTab(); // Ainda está vazia
            populatePendingTransfersTab(); // Ainda está vazia
            // ... outras abas
        }
    }
}

// --- FUNÇÕES DAS ABAS DE ADMINISTRAÇÃO ---

/**
 * CORREÇÃO: Implementação mínima para a aba de "Inventário Editável".
 * Renderiza a tabela e configura os filtros.
 */
function populateEditableInventoryTab() {
    const { patrimonioFullList } = getState();
    const tableBody = DOM.editTableBody;

    if (!tableBody || !patrimonioFullList) return;

    // Configura os filtros
    const tipos = [...new Set(patrimonioFullList.map(item => item.Tipo).filter(Boolean))].sort();
    DOM.editFilterTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${t}">${escapeHtml(t)}</option>`).join('');
    
    const estados = [...new Set(patrimonioFullList.map(item => item.Estado).filter(Boolean))].sort();
    DOM.editFilterEstado.innerHTML = '<option value="">Todos os Estados</option>' + estados.map(e => `<option value="${e}">${escapeHtml(e)}</option>`).join('');

    DOM.editFilterTipo.onchange = () => {
        const selectedTipo = DOM.editFilterTipo.value;
        const unidades = selectedTipo 
            ? [...new Set(patrimonioFullList.filter(i => i.Tipo === selectedTipo).map(i => i.Unidade).filter(Boolean))].sort()
            : [];
        
        DOM.editFilterUnidade.innerHTML = '<option value="">Todas as Unidades</option>' + unidades.map(u => `<option value="${u}">${escapeHtml(u)}</option>`).join('');
        DOM.editFilterUnidade.disabled = !selectedTipo;
        applyEditFiltersAndRender();
    };
    
    // Adiciona listeners de filtro
    DOM.editFilterUnidade.onchange = applyEditFiltersAndRender;
    DOM.editFilterEstado.onchange = applyEditFiltersAndRender;
    DOM.editFilterDescricao.oninput = debounce(applyEditFiltersAndRender, 300);

    // Renderiza a tabela inicial
    applyEditFiltersAndRender();
}

/**
 * Filtra a lista de patrimônio com base nos controles da aba de edição e renderiza a tabela.
 */
function applyEditFiltersAndRender() {
    const { patrimonioFullList } = getState();
    if (!patrimonioFullList) return;

    const tipo = DOM.editFilterTipo.value;
    const unidade = DOM.editFilterUnidade.value;
    const estado = DOM.editFilterEstado.value;
    const busca = normalizeStr(DOM.editFilterDescricao.value);

    patrimonioFilteredList = patrimonioFullList.filter(item => {
        const descMatch = !busca || normalizeStr(item.Descrição).includes(busca);
        const tomboMatch = !busca || normalizeStr(item.Tombamento).includes(busca);
        
        return (!tipo || item.Tipo === tipo) &&
               (!unidade || item.Unidade === unidade) &&
               (!estado || item.Estado === estado) &&
               (descMatch || tomboMatch);
    });

    if (unidade) {
        const count = patrimonioFilteredList.length;
        DOM.unitItemCount.textContent = `${count} item(ns)`;
    } else {
        DOM.unitItemCount.textContent = '';
    }

    renderEditableTable();
}

/**
 * Renderiza o corpo da tabela de edição com os itens filtrados.
 */
function renderEditableTable() {
    const tableBody = DOM.editTableBody;
    // Limita a 200 itens para performance. Filtros mais específicos são necessários.
    const itemsToDisplay = patrimonioFilteredList.slice(0, 200); 

    if (itemsToDisplay.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="14" class="text-center p-10 text-slate-500">Nenhum item encontrado com os filtros atuais.</td></tr>`;
        return;
    }

    tableBody.innerHTML = itemsToDisplay.map(item => `
        <tr class="border-b border-slate-200" data-id="${item.id}">
            <td class="p-2 align-top"><input type="checkbox" class="h-4 w-4 rounded border-gray-300 item-checkbox" data-id="${item.id}"></td>
            <td class="p-2 align-top whitespace-nowrap">
                <button class="edit-item-btn p-1 text-blue-600 hover:text-blue-800" data-id="${item.id}" title="Editar">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/><path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z"/></svg>
                </button>
                <button class="delete-item-btn p-1 text-red-600 hover:text-red-800" data-id="${item.id}" title="Excluir">
                     <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11z"/></svg>
                </button>
            </td>
            <td class="p-2 align-top font-mono text-xs">${escapeHtml(item.Tombamento || 'S/T')}</td>
            <td class="p-2 align-top"></td> <!-- Opções -->
            <td class="p-2 align-top">${escapeHtml(item.Descrição)}</td>
            <td class="p-2 align-top">${escapeHtml(item.Tipo)}</td>
            <td class="p-2 align-top">${escapeHtml(item.Unidade)}</td>
            <td class="p-2 align-top">${escapeHtml(item.Localização)}</td>
            <td class="p-2 align-top">${escapeHtml(item.Fornecedor)}</td>
            <td class="p-2 align-top">${escapeHtml(item.NF)}</td>
            <td class="p-2 align-top">${escapeHtml(item['Origem da Doação'])}</td>
            <td class="p-2 align-top">${escapeHtml(item.Estado)}</td>
            <td class="p-2 align-top">${escapeHtml(item.Quantidade)}</td>
            <td class="p-2 align-top text-xs">${escapeHtml(item.Observação)}</td>
        </tr>
    `).join('');

    if (patrimonioFilteredList.length > 200) {
        tableBody.innerHTML += `<tr><td colspan="14" class="text-center p-4 font-semibold text-amber-700 bg-amber-50">Exibindo 200 de ${patrimonioFilteredList.length} itens. Use filtros mais específicos para ver mais.</td></tr>`;
    }
}


function populateUnitMappingTab() { /* ... Lógica de mapeamento de unidades ... */ }
function populateReconciliationTab() { /* ... Lógica de conciliação ... */ }
function populatePendingTransfersTab() { /* ... Lógica de transferências pendentes ... */ }


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
    
    // Exemplo de Listener de Edição
    DOM.editTableBody.addEventListener('change', (e) => {
        // ... (Lógica para marcar item como 'dirty' e salvar no estado local/transitorio)
        // Isso seria o ponto de entrada para atualizações no dirtyItems.
    });

    // Salvar todas as alterações (simplificado)
    DOM.saveAllChangesBtn.addEventListener('click', async () => {
        if (dirtyItems.size === 0) return;
        showOverlay(`Salvando ${dirtyItems.size} alterações...`);
        // const batch = writeBatch(doc.db); // Assume doc.db é o db importado
        // ... lógica de commit do batch
        try {
            // await batch.commit();
            // Atualiza o estado global e o cache
            // await updateLocalCache(updatedPatrimonioList, getState().giapInventory);
            showNotification(`Alterações salvas!`, 'success');
        } catch (error) {
            showNotification('Erro ao salvar alterações.', 'error');
        } finally {
            hideOverlay();
        }
    });

    // Fechar Modais (Overlay ou Botão genérico)
    document.addEventListener('click', (e) => { 
        if (e.target.matches('.js-close-modal') || e.target.matches('.modal-overlay')) { 
            e.target.closest('.modal')?.classList.add('hidden'); 
        } 
    });
}

function init() {
    // Assina o Listener Global
    subscribe(updateUIFromState);

    // Configura Listeners de Eventos
    setupListeners();
}

document.addEventListener('DOMContentLoaded', init);

