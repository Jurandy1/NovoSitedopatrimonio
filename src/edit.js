/**// /src/edit.js
// Ponto de entrada e controlador principal da página de edição e auditoria (edit.html).
// Funciona como ORQUESTRADOR, carregando dados e delegando a lógica das abas.


// --- IMPORTS DE SERVIÇOS E ESTADO ---
// CORREÇÃO: Adicionada a variável 'db' e removidos comandos duplicados
import { auth, addAuthListener, handleLogout, loadFirebaseInventory, loadUnitMappingFromFirestore, loadReconciledUnits, loadCustomGiapUnits, loadConciliationPatterns, writeBatch, doc, updateDoc, serverT, db } from './services/firebase.js';
import { loadGiapInventory } from './services/giapService.js';
// CORREÇÃO ESSENCIAL: Adicionando 'isCacheStale', 'loadFromCache', e 'updateLocalCache'
import { isCacheStale, loadFromCache, updateLocalCache } from './services/cache.js'; 
// INÍCIO DA ALTERAÇÃO: Importar normalizeTombo
import { showNotification, showOverlay, hideOverlay, normalizeStr, escapeHtml, normalizeTombo } from './utils/helpers.js';
// FIM DA ALTERAÇÃO
import { subscribe, setState, getState } from './state/globalStore.js';

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
    
    // CORREÇÃO: Removidos imports duplicados que estavam dentro do objeto DOM e causavam o SyntaxError.
    subTabNavConciliar: document.querySelectorAll('#content-conciliar .sub-nav-btn'),
    subTabNavImportacao: document.querySelectorAll('#content-importacao .sub-nav-btn'),

    // INÍCIO DA ALTERAÇÃO: Novo Modal "Atualizar do GIAP"
    updateAllFromGiapBtn: document.getElementById('update-all-from-giap-btn'),
    updateAllGiapModal: document.getElementById('update-all-giap-modal'),
    updateAllModalBody: document.getElementById('update-all-modal-body'),
    updateAllLoading: document.getElementById('update-all-loading'),
    updateAllList: document.getElementById('update-all-list'),
    updateAllConfirmBtn: document.getElementById('update-all-confirm-btn'),
    // FIM DA ALTERAÇÃO
    
    // Elementos do modal de Sincronização
    syncConfirmModal: document.getElementById('sync-confirm-modal'),
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
    
    // Linha 64 (Original): isCacheStale estava sendo chamado sem ser importado.
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
    // INÍCIO DA ALTERAÇÃO: Usar normalizeTombo
    const giapMapAllItems = new Map(giapInventory.map(item => [normalizeTombo(item['TOMBAMENTO']), item]));
    const giapMap = new Map(giapInventory
        .filter(item => normalizeStr(item.Status).includes(normalizeStr('Disponível')))
        .map(item => [normalizeTombo(item['TOMBAMENTO']), item])
    );
    // FIM DA ALTERAÇÃO
    
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
    // INÍCIO DA ALTERAÇÃO: Usar normalizeTombo para o lookup
    const tombo = normalizeTombo(item.Tombamento);
    // FIM DA ALTERAÇÃO
    const giapItem = tombo ? giapMapAllItems.get(tombo) : null;

    if (!giapItem) {
        // Se não for encontrado, abre o modal para exibir a mensagem de erro/aviso.
        document.getElementById('sync-item-tombo').textContent = tombo;
        document.getElementById('sync-current-desc').textContent = item.Descrição;
        
        // Mensagem de Não Encontrado
        document.getElementById('sync-new-desc').textContent = 'ITEM NÃO ENCONTRADO NA PLANILHA GIAP.';
        document.getElementById('sync-new-desc').classList.add('text-red-600', 'bg-red-100');
        
        // Esconde os botões de ação (manter/atualizar)
        document.getElementById('sync-update-all-btn').classList.add('hidden');
        document.getElementById('sync-keep-desc-btn').classList.add('hidden');
        
        // Garante que o botão de cancelar/fechar esteja visível
        document.getElementById('sync-cancel-btn').textContent = 'Fechar';

        DOM.syncConfirmModal.classList.remove('hidden');
        return showNotification(`Item ${item.Tombamento} não encontrado na planilha GIAP.`, 'warning');
    }
    
    // Configuração para item ENCONTRADO
    document.getElementById('sync-item-tombo').textContent = tombo;
    document.getElementById('sync-current-desc').textContent = item.Descrição;
    document.getElementById('sync-new-desc').textContent = giapItem.Descrição || giapItem.Espécie;
    
    // Reset de classes de erro e visibilidade dos botões de ação
    document.getElementById('sync-new-desc').classList.remove('text-red-600', 'bg-red-100');
    document.getElementById('sync-new-desc').classList.add('text-green-700', 'bg-green-50');
    
    document.getElementById('sync-update-all-btn').classList.remove('hidden');
    document.getElementById('sync-keep-desc-btn').classList.remove('hidden');
    document.getElementById('sync-cancel-btn').textContent = 'Cancelar';


    // Configura os botões do modal para a ação
    document.getElementById('sync-update-all-btn').dataset.id = item.id;
    document.getElementById('sync-update-all-btn').dataset.giapTombo = tombo;
    document.getElementById('sync-keep-desc-btn').dataset.id = item.id;
    document.getElementById('sync-keep-desc-btn').dataset.giapTombo = tombo;
    
    // Adiciona a descrição atual para que a função de confirmação possa usá-la se KEEP for escolhido
    document.getElementById('sync-keep-desc-btn').dataset.currentDesc = item.Descrição;

    DOM.syncConfirmModal.classList.remove('hidden');
}

/**
 * Lida com a confirmação da sincronização no modal.
 * @param {string} id - ID do item no Firestore.
 * @param {string} tombo - Tombo do item (já normalizado).
 * @param {boolean} updateDesc - Se deve atualizar a descrição com a do GIAP.
 * @param {string} currentDesc - A descrição que já estava no sistema.
 */
async function confirmSyncAction(id, tombo, updateDesc, currentDesc) {
    const { giapMapAllItems, patrimonioFullList } = getState();
    const giapItem = giapMapAllItems.get(tombo);
    if (!giapItem) return;

    showOverlay('Sincronizando item...');
    
    const item = patrimonioFullList.find(i => i.id === id);
    
    const changes = {
        Fornecedor: giapItem['Nome Fornecedor'] || '',
        NF: giapItem['NF'] || '',
        Cadastro: giapItem['Cadastro'] || '',
        'Tipo Entrada': giapItem['Tipo Entrada'] || '',
        Unidade_Planilha: giapItem['Unidade'] || '', // Salva a unidade original da planilha
        'Valor NF': giapItem['Valor NF'] || '',
        Espécie: giapItem['Espécie'] || '',
        Status_Planilha: giapItem['Status'] || '', // Salva o status original da planilha
        updatedAt: serverT()
    };
    
    if (updateDesc) {
        changes.Descrição = giapItem.Descrição || giapItem.Espécie;
        changes.Observação = `Descrição e meta-dados atualizados do GIAP. | ${giapItem.Unidade}`;
    } else {
        changes.Descrição = currentDesc; // Mantém a descrição que já estava no sistema
        changes.Observação = `Meta-dados atualizados do GIAP. Descrição mantida. | ${giapItem.Unidade}`;
    }
    
    try {
        // 1. Atualiza no Firestore
        await updateDoc(doc(db, 'patrimonio', id), changes);
        
        // 2. Atualiza o estado global (patrimonioFullList) e o cache imediatamente
        const itemIndex = patrimonioFullList.findIndex(i => i.id === id);
        if (itemIndex > -1) {
            const updatedItem = { ...patrimonioFullList[itemIndex], ...changes };
            patrimonioFullList[itemIndex] = updatedItem;
            setState({ patrimonioFullList }); // Notifica a UI
            
            // O tabInventario.js precisa do item atualizado no cache para ler os novos valores corretamente
            await idb.patrimonio.put(updatedItem); 
        }
        
        showNotification('Item sincronizado com sucesso!', 'success');
        
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
// ... (código inalterado)
// ...
}


// --- INÍCIO DA ALTERAÇÃO: Funções do Novo Modal "Atualizar do GIAP" ---

/**
 * Manipulador de clique para o botão "Atualizar do GIAP".
// ... (código inalterado)
// ...
 * @param {Array<object>} itemsToReview - Itens para exibir no modal.
 */
function renderUpdateAllList(itemsToReview) {
// ... (código inalterado)
// ...
}


/**
 * Manipulador de clique para o botão "Confirmar" do novo modal.
// ... (código inalterado)
// ...
    // FIM DA ALTERAÇÃO
}

// --- LISTENERS E INICIALIZAÇÃO ---

function setupListeners() {

    // --- CORREÇÃO (Início) ---
    // Cria uma função nomeada para o callback de autenticação
    function handleAuthStateChange(user) {
        const isLoggedIn = !!user;
        
        // Verifica se as funções de estado estão prontas
        if (typeof setState !== 'function' || typeof getState !== 'function') {
            console.error("Auth callback: setState ou getState não estão definidas. Problema de carregamento de módulo.");
            // Não podemos continuar se não pudermos definir o estado.
            return; 
        }

        setState({ isLoggedIn, user, authReady: true });
        
        const state = getState(); // Agora é seguro chamar
        if (!state) {
            console.error("Auth callback: O estado global não está pronto.");
            return;
        }

        // CORREÇÃO: Chama loadData() APENAS se estiver logado E o carregamento inicial ainda não foi concluído.
        if (isLoggedIn && !state.initialLoadComplete) {
            loadData(false); 
        }
    }
    
    // Auth Listener
    // Passa a função nomeada para o addAuthListener
    addAuthListener(handleAuthStateChange);
    // --- CORREÇÃO (Fim) ---


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

            // --- CORREÇÃO (Início) ---
            // Adiciona uma trava de segurança para getState
            if (typeof getState !== 'function') {
                console.error("Tab click: getState não está definida.");
                return;
            }
            const state = getState();
            if (!state) {
                console.error("Tab click: O estado global não está pronto.");
                return;
            }
            // --- CORREÇÃO (Fim) ---

            if (tabName === 'giap') renderGiapInventoryTable(state.giapInventory);

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
    // CORREÇÃO: Passa a função loadData para setupLigarUnidadesListeners
    setupLigarUnidadesListeners(loadData);
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
        confirmSyncAction(id, tombo, true, null); // true = Atualiza descrição
    });

    document.getElementById('sync-keep-desc-btn').addEventListener('click', (e) => {
        const id = e.target.dataset.id;
        const tombo = e.target.dataset.giapTombo;
        const currentDesc = e.target.dataset.currentDesc; // Pega a descrição atual salva no data-attribute
        DOM.syncConfirmModal.classList.add('hidden');
        confirmSyncAction(id, tombo, false, currentDesc); // false = Mantém descrição atual
    });
    
    // Fechar Modais (Overlay ou Botão genérico)
    document.addEventListener('click', (e) => { 
        if (e.target.matches('.js-close-modal-add') || e.target.matches('.modal-overlay')) { 
            e.target.closest('.modal')?.classList.add('hidden'); 
        } 
    });

    // --- INÍCIO DA ALTERAÇÃO: Listeners do Novo Modal "Atualizar do GIAP" ---
    DOM.updateAllFromGiapBtn.addEventListener('click', handleUpdateAllFromGiap);
    DOM.updateAllConfirmBtn.addEventListener('click', handleUpdateAllConfirm);
    
    // Fechar o novo modal e listeners de ações em massa
    DOM.updateAllGiapModal.addEventListener('click', (e) => {
        const target = e.target;
        
        if (target.matches('.js-close-modal-update-all') || target.matches('.modal-overlay')) {
            DOM.updateAllGiapModal.classList.add('hidden');
        }

        // (Req #3) Bulk Select All
        if (target.id === 'update-all-select-all') {
            const isChecked = target.checked;
            DOM.updateAllList.querySelectorAll('.update-all-checkbox').forEach(cb => {
                cb.checked = isChecked;
            });
        }

        // (Req #3) Bulk Apply Action
        if (target.id === 'update-all-bulk-apply-btn') {
            const action = document.getElementById('update-all-bulk-action-select').value;
            if (!action) {
                return showNotification('Selecione uma ação em massa para aplicar.', 'warning');
            }
            
            const checkedBoxes = DOM.updateAllList.querySelectorAll('.update-all-checkbox:checked');
            if (checkedBoxes.length === 0) {
                return showNotification('Nenhum item selecionado.', 'warning');
            }
            
            let appliedCount = 0;
            checkedBoxes.forEach(cb => {
                const id = cb.dataset.id;
                
                // Tenta aplicar a ações de "Divergência"
                if (action === 'update' || action === 'keep' || action === 'mark-permuta') {
                    const select = DOM.updateAllList.querySelector(`select.update-choice[data-id="${id}"]`);
                    if (select) {
                        select.value = action;
                        appliedCount++;
                    }
                // Tenta aplicar a ações de "Não Encontrado"
                } else if (action === 'mark-for-check') {
                     const select = DOM.updateAllList.querySelector(`select.update-choice-notfound[data-id="${id}"]`);
                    if (select) {
                        select.value = action;
                        appliedCount++;
                    }
                }
            });
            
            showNotification(`Ação aplicada a ${appliedCount} item(ns) compatíveis. Clique em "Confirmar" para salvar.`, 'info');
        }
    });
    // FIM DA ALTERAÇÃO
}

function init() {
    subscribe(updateUIFromState);
    setupListeners();
}

document.addEventListener('DOMContentLoaded', init);
