/**
 * src/edit.js
 * Ponto de entrada e controlador principal da página de edição e auditoria (edit.html).
 * Funciona como ORQUESTRADOR, carregando dados e delegando a lógica das abas.
 */

// --- IMPORTS DE SERVIÇOS E ESTADO ---
import { auth, addAuthListener, handleLogout, loadFirebaseInventory, loadUnitMappingFromFirestore, loadReconciledUnits, loadCustomGiapUnits, loadConciliationPatterns } from './services/firebase.js';
import { loadGiapInventory } from './services/giapService.js';
import { idb, isCacheStale, loadFromCache, updateLocalCache } from './services/cache.js';
import { showNotification, showOverlay, hideOverlay } from './utils/helpers.js';
import { subscribe, setState } from './state/globalStore.js';

// --- IMPORTS DOS MÓDULOS DE ADMINISTRAÇÃO (A LÓGICA DAS ABAS) ---
import { populateEditableInventoryTab, setupInventarioListeners } from './admin/tabInventario.js';
import { populateUnitMappingTab, setupLigarUnidadesListeners } from './admin/tabLigarUnidades.js';
import { populateReconciliationTab, setupConciliarListeners, renderItensATombar } from './admin/tabConciliar.js';
import { populatePendingTransfersTab, setupTransferenciasListeners } from './admin/tabTransferencias.js';
import { populateImportAndReplaceTab, setupImportacaoListeners } from './admin/tabImportacao.js';
import { populateNfTab, setupNotasFiscaisListeners } from './admin/tabNotasFiscais.js';
import { setupSobrantesSearchListeners } from './admin/tabSobrantesSearch.js'; // Aba Tombos Sobrando

// --- DOM ELEMENTS (Apenas os essenciais para a orquestração e UI global) ---
const DOM = {
    loadingScreen: document.getElementById('loading-or-error-screen'),
    authGate: document.getElementById('auth-gate'),
    feedbackStatus: document.getElementById('feedback-status'),
    forceRefreshBtn: document.getElementById('force-refresh-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    navButtons: document.querySelectorAll('#edit-nav .nav-btn'),
    contentPanes: document.querySelectorAll('main > div[id^="content-"]'),
    
    // Modais (sincronização e adição de item)
    syncConfirmModal: document.getElementById('sync-confirm-modal'),
    addItemModal: document.getElementById('add-item-modal'),

    // Navegação de Sub-abas (usada aqui para gerenciar a troca de conteúdo)
    subTabNavConciliar: document.querySelectorAll('#content-conciliar .sub-nav-btn'),
    subTabNavImportacao: document.querySelectorAll('#content-importacao .sub-nav-btn'),
};

// --- ESTADO LOCAL/TRANSITÓRIO DO ORQUESTRADOR ---
// Nenhum estado de aba fica aqui.

// --- INICIALIZAÇÃO E CARREGAMENTO DE DADOS ---

/**
 * Carrega todos os dados, priorizando o cache ou forçando o fetch.
 * @param {boolean} forceRefresh - Se deve forçar o fetch do servidor.
 */
async function loadData(forceRefresh = false) {
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

    // Cria os mapas para acesso rápido (essencial para as abas)
    const giapMapAllItems = new Map(giapInventory.map(item => [item['TOMBAMENTO']?.trim(), item]));
    const giapMap = new Map(giapInventory
        .filter(item => normalizeStr(item.Status).includes(normalizeStr('Disponível')))
        .map(item => [item['TOMBAMENTO']?.trim(), item])
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
            // Inicializa a UI de todas as abas
            populateEditableInventoryTab();
            populateUnitMappingTab(); 
            populateReconciliationTab();
            populatePendingTransfersTab(loadData); 
            populateImportAndReplaceTab(); 
            populateNfTab();
            // A aba GIAP não precisa de função de "populate" complexa, pois é só renderizar o array.
            renderGiapInventoryTable(state.giapInventory); 
        }
    }
}

// --- FUNÇÕES GLOBAIS DE MODAIS ---

/**
 * Abre o modal de sincronização com o GIAP.
 */
function openSyncModal(item) {
    const { giapMapAllItems } = getState();
    const tombo = item.Tombamento?.trim();
    const giapItem = tombo ? giapMapAllItems.get(tombo) : null;

    if (!giapItem) {
        return showNotification(`Item ${tombo} não encontrado na planilha GIAP.`, 'warning');
    }
    
    document.getElementById('sync-item-tombo').textContent = tombo;
    document.getElementById('sync-current-desc').textContent = item.Descrição;
    document.getElementById('sync-new-desc').textContent = giapItem.Descrição || giapItem.Espécie;
    
    // Configura os botões do modal para a ação
    document.getElementById('sync-update-all-btn').dataset.id = item.id;
    document.getElementById('sync-update-all-btn').dataset.giapTombo = tombo;
    document.getElementById('sync-keep-desc-btn').dataset.id = item.id;
    document.getElementById('sync-keep-desc-btn').dataset.giapTombo = tombo;
    
    DOM.syncConfirmModal.classList.remove('hidden');
}

/**
 * Lida com a confirmação da sincronização no modal.
 * @param {string} id - ID do item no Firestore.
 * @param {string} tombo - Tombo do item.
 * @param {boolean} updateDesc - Se deve atualizar a descrição com a do GIAP.
 */
async function confirmSyncAction(id, tombo, updateDesc) {
    const { giapMapAllItems } = getState();
    const giapItem = giapMapAllItems.get(tombo);
    if (!giapItem) return;

    showOverlay('Sincronizando item...');
    
    const changes = {
        Fornecedor: giapItem['Nome Fornecedor'] || '',
        NF: giapItem['NF'] || '',
        Observação: updateDesc ? `Descrição atualizada do GIAP. | ${giapItem.Unidade}` : `Meta-dados atualizados. | ${giapItem.Unidade}`,
        updatedAt: serverT()
    };
    
    if (updateDesc) {
        changes.Descrição = giapItem.Descrição || giapItem.Espécie;
    }
    
    try {
        await updateDoc(doc(db, 'patrimonio', id), changes);
        showNotification('Item sincronizado com sucesso!', 'success');
        
        // Dispara recarregamento para atualizar a tabela editável
        loadData(true); 
    } catch (e) {
        hideOverlay();
        showNotification('Erro ao sincronizar item.', 'error');
        console.error(e);
    }
}

/**
 * Renderiza a tabela da Planilha GIAP (conteúdo da aba 'giap').
 */
function renderGiapInventoryTable(giapInventory) {
    const tableBody = document.getElementById('giap-table-body');
    if (!giapInventory || giapInventory.length === 0 || !tableBody) return;

    const headers = Object.keys(giapInventory[0]);
    const tableHead = document.querySelector('#content-giap thead tr');

    tableHead.innerHTML = headers.map(h => `<th class="p-3 text-left font-semibold">${escapeHtml(h)}</th>`).join('');
    
    tableBody.innerHTML = giapInventory.slice(0, 500).map(item => `
        <tr class="border-b border-slate-200 hover:bg-slate-50">
            ${headers.map(h => `<td class="p-2 text-xs">${escapeHtml(item[h])}</td>`).join('')}
        </tr>
    `).join('');
}


// --- LISTENERS E INICIALIZAÇÃO ---

function setupListeners() {
    // Auth Listener
    addAuthListener(user => {
        const isLoggedIn = !!user;
        setState({ isLoggedIn, user, authReady: true });
        if (isLoggedIn && !getState().initialLoadComplete) {
            loadData(false); // Inicia o carregamento de dados quando logado
        }
    });

    // Forçar Atualização
    DOM.forceRefreshBtn.addEventListener('click', () => loadData(true));
    DOM.logoutBtn.addEventListener('click', () => { handleLogout(); window.location.href = 'index.html'; });
    
    // Navegação por Abas Principais
    DOM.navButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const tabName = e.currentTarget.dataset.tab;
            DOM.navButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));
            DOM.contentPanes.forEach(pane => pane.classList.toggle('hidden', !pane.id.includes(tabName)));
            
            // Re-popula abas complexas ao abrir
            if (tabName === 'transferencias') populatePendingTransfersTab(loadData);
            if (tabName === 'unidades') populateUnitMappingTab();
            if (tabName === 'notas_fiscais') populateNfTab();
            if (tabName === 'giap') renderGiapInventoryTable(getState().giapInventory);

            // Re-popula a aba de conciliação ao abrir
            if (tabName === 'conciliar') {
                 // Reseta o estado local da conciliação (feito dentro do módulo)
                 populateReconciliationTab();
            }
        });
    });
    
    // Navegação de Sub-abas (Conciliar e Importação)
    const handleSubTabNav = (event) => {
        const btn = event.currentTarget;
        const parentNav = btn.closest('.flex.border-b');
        const parentCard = btn.closest('.card');
        const subTab = btn.dataset.subtab || btn.dataset.subtabConciliar;

        parentNav.querySelectorAll('.sub-nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const prefix = btn.dataset.subtabConciliar ? 'subtab-conciliar-' : 'subtab-content-';
        parentCard.querySelectorAll(`div[id^="${prefix}"]`).forEach(pane => {
            pane.classList.toggle('hidden', pane.id !== `${prefix}${subTab}`);
        });

        if (btn.dataset.subtabConciliar === 'itens_a_tombar') {
            renderItensATombar(); // Força a renderização ao entrar na sub-aba
        }
    };
    DOM.subTabNavConciliar.forEach(btn => btn.addEventListener('click', handleSubTabNav));
    DOM.subTabNavImportacao.forEach(btn => btn.addEventListener('click', handleSubTabNav));


    // --- Delega a lógica das abas para seus respectivos módulos ---
    setupInventarioListeners(loadData, openSyncModal);
    setupLigarUnidadesListeners();
    setupConciliarListeners(loadData);
    setupTransferenciasListeners(loadData);
    setupImportacaoListeners(loadData);
    setupNotasFiscaisListeners();
    setupSobrantesSearchListeners(); // Tombos Sobrando (Busca global)

    // --- Listeners de Modais Globais ---

    // Listener do Modal de Sincronização
    document.getElementById('sync-cancel-btn').addEventListener('click', () => DOM.syncConfirmModal.classList.add('hidden'));
    
    document.getElementById('sync-update-all-btn').addEventListener('click', (e) => {
        const id = e.target.dataset.id;
        const tombo = e.target.dataset.giapTombo;
        DOM.syncConfirmModal.classList.add('hidden');
        confirmSyncAction(id, tombo, true); // Atualiza descrição
    });

    document.getElementById('sync-keep-desc-btn').addEventListener('click', (e) => {
        const id = e.target.dataset.id;
        const tombo = e.target.dataset.giapTombo;
        DOM.syncConfirmModal.classList.add('hidden');
        confirmSyncAction(id, tombo, false); // Não atualiza descrição
    });
    
    // Fechar Modais (Overlay ou Botão genérico)
    document.addEventListener('click', (e) => { 
        if (e.target.matches('.js-close-modal-add') || e.target.matches('.modal-overlay')) { 
            e.target.closest('.modal')?.classList.add('hidden'); 
        } 
    });
}

function init() {
    subscribe(updateUIFromState);
    setupListeners();
}

document.addEventListener('DOMContentLoaded', init);
