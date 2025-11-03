/**
 * src/edit.js
 * Ponto de entrada e controlador principal da página de edição e auditoria (edit.html).
 * Funciona como ORQUESTRADOR, carregando dados e delegando a lógica das abas.
 */

// --- IMPORTS DE SERVIÇOS E ESTADO ---
import { auth, addAuthListener, handleLogout, loadFirebaseInventory, loadUnitMappingFromFirestore, loadReconciledUnits, loadCustomGiapUnits, loadConciliationPatterns, writeBatch, doc, updateDoc, serverT } from './services/firebase.js';
import { loadGiapInventory } from './services/giapService.js';
import { idb, isCacheStale, loadFromCache, updateLocalCache } from './services/cache.js';
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
    
 // --- IMPORTS DE SERVIÇOS E ESTADO ---
-import { auth, addAuthListener, handleLogout, loadFirebaseInventory, loadUnitMappingFromFirestore, loadReconciledUnits, loadCustomGiapUnits, loadConciliationPatterns, writeBatch, doc, updateDoc, serverT } from './services/firebase.js';
+import { auth, addAuthListener, handleLogout, loadFirebaseInventory, loadUnitMappingFromFirestore, loadReconciledUnits, loadCustomGiapUnits, loadConciliationPatterns, writeBatch, doc, updateDoc, serverT, db } from './services/firebase.js';
 import { loadGiapInventory } from './services/giapService.js';
 import { idb, isCacheStale, loadFromCache, updateLocalCache } from './services/cache.js';
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
    // INÍCIO DA ALTERAÇÃO: Usar normalizeTombo para criar os mapas
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
        // INÍCIO DA ALTERAÇÃO: Lógica de sugestão (ainda não implementada)
        // Por enquanto, apenas informamos que não foi encontrado.
        // A lógica de "sugestão" (1403 vs 14032) é complexa (Levenshtein) e não foi implementada.
        // A lógica de `014032` vs `14032` JÁ ESTÁ FUNCIONANDO devido à mudança no `loadData`.
        // FIM DA ALTERAÇÃO
        return showNotification(`Item ${item.Tombamento} (normalizado para ${tombo}) não encontrado na planilha GIAP.`, 'warning');
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
 * @param {string} tombo - Tombo do item (já normalizado).
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
        // INÍCIO DA ALTERAÇÃO: Atualiza todos os campos solicitados
        Cadastro: giapItem['Cadastro'] || '',
        'Tipo Entrada': giapItem['Tipo Entrada'] || '',
        Unidade_Planilha: giapItem['Unidade'] || '', // Salva a unidade original da planilha
        'Valor NF': giapItem['Valor NF'] || '',
        Espécie: giapItem['Espécie'] || '',
        Status_Planilha: giapItem['Status'] || '', // Salva o status original da planilha
        // FIM DA ALTERAÇÃO
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


// --- INÍCIO DA ALTERAÇÃO: Funções do Novo Modal "Atualizar do GIAP" ---

/**
 * Manipulador de clique para o botão "Atualizar do GIAP".
 * Inicia a verificação e abre o modal.
 */
async function handleUpdateAllFromGiap() {
    DOM.updateAllGiapModal.classList.remove('hidden');
    DOM.updateAllList.classList.add('hidden');
    DOM.updateAllLoading.classList.remove('hidden');
    DOM.updateAllConfirmBtn.disabled = true;

    const { patrimonioFullList, giapMapAllItems } = getState();
    const itemsToReview = [];

    patrimonioFullList.forEach(item => {
        // (Req #5/6) Ignora itens já marcados para verificação
        if (item.Observação?.includes('Verificar tombo')) {
            return;
        }

        const normalizedTombo = normalizeTombo(item.Tombamento);
        // Ignora S/T e Permuta
        if (!normalizedTombo || normalizedTombo === 's/t' || item.isPermuta) {
            return; 
        }

        const giapItem = giapMapAllItems.get(normalizedTombo);

        if (giapItem) {
            const giapDesc = giapItem.Descrição || giapItem.Espécie;
            // (Req #6) Verifica se a descrição é diferente
            if (normalizeStr(item.Descrição) !== normalizeStr(giapDesc)) {
                itemsToReview.push({ item, giapItem, status: 'name-change' });
            }
        } else {
            itemsToReview.push({ item, status: 'not-found' });
        }
    });

    renderUpdateAllList(itemsToReview);
    DOM.updateAllLoading.classList.add('hidden');
    DOM.updateAllList.classList.remove('hidden');
    DOM.updateAllConfirmBtn.disabled = itemsToReview.length === 0;
}

/**
 * Renderiza a lista de itens para revisão no modal.
 * @param {Array<object>} itemsToReview - Itens para exibir no modal.
 */
function renderUpdateAllList(itemsToReview) {
    if (itemsToReview.length === 0) {
        DOM.updateAllList.innerHTML = `<p class="text-center text-green-600 font-semibold p-4">Parabéns! Todos os itens com tombamento parecem estar sincronizados com o GIAP.</p>`;
        return;
    }

    // (Req #3) Bulk Actions HTML
    const bulkActionsHtml = `
        <div id="update-all-bulk-actions" class="p-3 bg-slate-100 rounded-lg flex flex-wrap items-center gap-4">
            <label class="flex items-center font-medium">
                <input type="checkbox" id="update-all-select-all" class="h-4 w-4 mr-2">
                Selecionar Todos
            </label>
            <select id="update-all-bulk-action-select" class="p-2 border rounded-lg bg-white text-sm">
                <option value="">-- Ação em Massa --</option>
                <option value="update">Atualizar para Nome do GIAP</option>
                <option value="keep">Manter Nome Atual</option>
                <option value="mark-permuta">Marcar como PERMUTA</option>
                <option value="mark-for-check">Marcar 'Verificar Tombo'</option>
            </select>
            <button id="update-all-bulk-apply-btn" class="bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700">Aplicar aos Selecionados</button>
        </div>`;

    // (Req #1, #2, #4) Updated Name Change HTML
    const nameChangeHtml = itemsToReview
        .filter(r => r.status === 'name-change')
        .map(r => `
            <div class="p-3 bg-yellow-50 border-l-4 border-yellow-500 rounded-r-lg">
                <div class="flex items-start">
                    <input type="checkbox" class="update-all-checkbox mt-1 h-5 w-5" data-id="${escapeHtml(r.item.id)}">
                    <div class="ml-3 flex-1">
                        <p class="font-semibold text-yellow-800">Divergência na Descrição</p>
                        <p class="text-sm"><strong>Tombo:</strong> ${escapeHtml(r.item.Tombamento)} | <strong>Estado Atual:</strong> <span class="font-bold">${escapeHtml(r.item.Estado || 'N/D')}</span></p>
                        <p class="text-xs"><strong>Espécie (GIAP):</strong> ${escapeHtml(r.giapItem.Espécie || 'N/A')} | <strong>Cadastro (GIAP):</strong> ${escapeHtml(r.giapItem.Cadastro || 'N/A')}</p>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2 text-sm">
                            <div>
                                <p class="font-medium">Descrição Atual no Sistema:</p>
                                <p class="p-2 bg-white rounded border">${escapeHtml(r.item.Descrição)}</p>
                            </div>
                            <div>
                                <p class="font-medium">Descrição na Planilha GIAP:</p>
                                <p class="p-2 bg-white rounded border">${escapeHtml(r.giapItem.Descrição || r.giapItem.Espécie)}</p>
                            </div>
                        </div>
                        <div class="mt-2">
                            <label class="font-medium text-sm">Ação:</label>
                            <select class="update-choice w-full p-2 border rounded-lg bg-white" data-id="${escapeHtml(r.item.id)}">
                                <option value="keep" selected>Manter Nome Atual (e não atualizar outros dados)</option>
                                <option value="update">Atualizar para Nome do GIAP (e todos os outros dados)</option>
                                <option value="mark-permuta">Marcar como PERMUTA (Remove Tombo)</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');

    // (Req #1, #5) Updated Not Found HTML
    const notFoundHtml = itemsToReview
        .filter(r => r.status === 'not-found')
        .map(r => `
            <div class="p-3 bg-red-50 border-l-4 border-red-500 rounded-r-lg">
                <div class="flex items-start">
                    <input type="checkbox" class="update-all-checkbox mt-1 h-5 w-5" data-id="${escapeHtml(r.item.id)}">
                    <div class="ml-3 flex-1">
                        <p class="font-semibold text-red-800">Não Encontrado no GIAP</p>
                        <p class="text-sm"><strong>Tombo:</strong> ${escapeHtml(r.item.Tombamento)}</p>
                        <p class="text-sm"><strong>Descrição:</strong> ${escapeHtml(r.item.Descrição)} | <strong>Estado:</strong> <span class="font-bold">${escapeHtml(r.item.Estado || 'N/D')}</span></p>
                        <div class="mt-2">
                            <label class="font-medium text-sm">Ação:</label>
                            <select class="update-choice-notfound w-full p-2 border rounded-lg bg-white" data-id="${escapeHtml(r.item.id)}">
                                <option value="ignore" selected>Ignorar por enquanto</option>
                                <option value="mark-for-check">Marcar 'Verificar Tombo' (e não mostrar mais)</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');

    // Combine all HTML
    DOM.updateAllList.innerHTML = `
        ${bulkActionsHtml}
        ${nameChangeHtml ? `<div classs="mt-4"><h4 class="text-lg font-semibold my-2">Itens com Mudança de Nome</h4><div class="space-y-3">${nameChangeHtml}</div></div>` : ''}
        ${notFoundHtml ? `<div class="mt-6"><h4 class="text-lg font-semibold my-2">Itens Não Encontrados</h4><div class="space-y-3">${notFoundHtml}</div></div>` : ''}
    `;
}


/**
 * Manipulador de clique para o botão "Confirmar" do novo modal.
 * Salva as alterações em lote.
 */
async function handleUpdateAllConfirm() {
    const { giapMapAllItems, patrimonioFullList } = getState();
    // (Req #4, #5) Get all selects from both lists
    const selects = DOM.updateAllList.querySelectorAll('select.update-choice, select.update-choice-notfound');
    
    if (selects.length === 0) {
        showNotification('Nenhuma ação selecionada.', 'info');
        DOM.updateAllGiapModal.classList.add('hidden');
        return;
    }

    showOverlay('Atualizando itens em lote...');
    const batch = writeBatch(db);
    let updateCount = 0;

    selects.forEach(select => {
        const id = select.dataset.id;
        const choice = select.value;
        const itemRef = doc(db, 'patrimonio', id);
        const item = patrimonioFullList.find(i => i.id === id); // Get item for context

        if (choice === 'update') {
            const giapItem = giapMapAllItems.get(normalizeTombo(item.Tombamento));
            if (giapItem) {
                updateCount++;
                batch.update(itemRef, {
                    Descrição: giapItem.Descrição || giapItem.Espécie,
                    Cadastro: giapItem.Cadastro || '',
                    NF: giapItem.NF || '',
                    'Nome Fornecedor': giapItem['Nome Fornecedor'] || '',
                    'Tipo Entrada': giapItem['Tipo Entrada'] || '',
                    Unidade_Planilha: giapItem.Unidade || '', 
                    'Valor NF': giapItem['Valor NF'] || '',
                    Espécie: giapItem.Espécie || '',
                    Status_Planilha: giapItem.Status || '', 
                    updatedAt: serverT()
                });
            }
        } else if (choice === 'mark-permuta') { // (Req #4)
            updateCount++;
            batch.update(itemRef, { 
                Tombamento: 'PERMUTA', 
                isPermuta: true, 
                Observação: 'Marcado como Permuta via auditoria.', 
                updatedAt: serverT() 
            });
        } else if (choice === 'mark-for-check') { // (Req #5)
            updateCount++;
            batch.update(itemRef, { 
                Observação: 'Verificar tombo (Não encontrado no GIAP)', 
                updatedAt: serverT() 
            });
        }
        // 'keep' and 'ignore' do nothing, which is correct.
    });

    if (updateCount === 0) {
        hideOverlay();
        showNotification('Nenhum item foi marcado para atualização.', 'info');
        DOM.updateAllGiapModal.classList.add('hidden');
        return;
    }

    try {
        await batch.commit();
        showNotification(`${updateCount} itens atualizados com sucesso! Recarregando...`, 'success');
        DOM.updateAllGiapModal.classList.add('hidden');
        loadData(true); // (Req #6) Force reload
    } catch (e) {
        hideOverlay();
        showNotification('Erro ao salvar atualizações em lote.', 'error');
        console.error(e);
    }
}
// FIM DA ALTERAÇÃO

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

        if (isLoggedIn && !state.initialLoadComplete) {
            loadData(false); // Inicia o carregamento de dados quando logado
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
