/**
 * /src/edit.js
 * Ponto de entrada e controlador principal da página de edição e auditoria (edit.html).
 * Funciona como ORQUESTRADOR, carregando dados e delegando a lógica das abas.
 */


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
    const container = document.getElementById('giap-table-body');
    const headerRow = document.querySelector('#content-giap thead tr');
    
    if (!container || !headerRow) return;
    
    if (giapInventory.length === 0) {
        headerRow.innerHTML = '';
        container.innerHTML = '<tr><td colspan="1" class="text-center p-10 text-slate-500">Nenhum dado do GIAP disponível.</td></tr>';
        return;
    }

    // Pega todos os cabeçalhos
    const headers = Object.keys(giapInventory[0]);
    headerRow.innerHTML = headers.map(h => `<th class="p-3 text-left font-semibold text-xs">${escapeHtml(h)}</th>`).join('');
    
    // Renderiza o corpo da tabela (limitando a 200 linhas para performance)
    container.innerHTML = giapInventory.slice(0, 200).map(item => {
        return `
            <tr class="border-b border-slate-200 hover:bg-slate-50">
                ${headers.map(header => `<td class="p-2 text-xs">${escapeHtml(item[header] || '')}</td>`).join('')}
            </tr>
        `;
    }).join('');
}


// --- INÍCIO DA ALTERAÇÃO: Funções do Novo Modal "Atualizar do GIAP" ---

/**
 * Manipulador de clique para o botão "Atualizar do GIAP".
 */
async function handleUpdateAllFromGiap() {
    DOM.updateAllGiapModal.classList.remove('hidden');
    DOM.updateAllLoading.classList.remove('hidden');
    DOM.updateAllList.classList.add('hidden');
    DOM.updateAllConfirmBtn.disabled = true;

    const { patrimonioFullList, giapMapAllItems } = getState();

    // 1. Encontra divergências
    const itemsToReview = [];

    // Filtra apenas itens tombados no sistema (ignora S/T e permuta)
    const tombadosNoSistema = patrimonioFullList.filter(item => {
        const tombo = normalizeTombo(item.Tombamento);
        return tombo && !tombo.includes('permuta');
    });

    // A. Comparação: Sistema vs GIAP
    tombadosNoSistema.forEach(systemItem => {
        const tombo = normalizeTombo(systemItem.Tombamento);
        const giapItem = giapMapAllItems.get(tombo);
        
        if (!giapItem) {
            // Item no sistema mas não na planilha GIAP (possivelmente baixado ou erro)
            itemsToReview.push({
                type: 'not_found',
                systemItem: systemItem,
                giapItem: null
            });
            return;
        }
        
        // Normaliza campos para comparação
        const systemDesc = normalizeStr(systemItem.Descrição);
        const giapDesc = normalizeStr(giapItem.Descrição || giapItem.Espécie);
        const systemLocal = normalizeStr(systemItem.Localização);
        const giapLocal = normalizeStr(giapItem.Localização);
        const systemUnidade = normalizeStr(systemItem.Unidade);
        const giapUnidade = normalizeStr(giapItem.Unidade);
        const giapFornecedor = normalizeStr(giapItem['Nome Fornecedor']);
        const systemFornecedor = normalizeStr(systemItem.Fornecedor);
        const giapNF = normalizeStr(giapItem.NF);
        const systemNF = normalizeStr(systemItem.NF);


        // Verifica se há alguma divergência significativa (Desc, Local, Unidade, NF, Fornecedor)
        const hasDivergence = 
            systemDesc !== giapDesc || 
            systemLocal !== giapLocal || 
            systemUnidade !== giapUnidade ||
            giapFornecedor !== systemFornecedor ||
            giapNF !== systemNF;

        if (hasDivergence) {
            itemsToReview.push({
                type: 'divergence',
                systemItem: systemItem,
                giapItem: giapItem,
                divergences: {
                    desc: systemDesc !== giapDesc,
                    local: systemLocal !== giapLocal,
                    unidade: systemUnidade !== giapUnidade,
                    fornecedor: giapFornecedor !== systemFornecedor,
                    nf: giapNF !== systemNF
                }
            });
        }
    });

    // 2. Renderiza os resultados
    renderUpdateAllList(itemsToReview);
    DOM.updateAllLoading.classList.add('hidden');
    DOM.updateAllList.classList.remove('hidden');
    DOM.updateAllConfirmBtn.disabled = itemsToReview.length === 0;
}

/**
 * Renderiza a lista de itens para revisão no modal "Atualizar do GIAP".
 * @param {Array<object>} itemsToReview - Itens para exibir no modal.
 */
function renderUpdateAllList(itemsToReview) {
    const listContainer = DOM.updateAllList;
    listContainer.innerHTML = '';

    if (itemsToReview.length === 0) {
        listContainer.innerHTML = `<p class="p-4 text-slate-500 text-center">Nenhuma divergência ou item perdido encontrado.</p>`;
        return;
    }

    let html = `
        <div class="p-3 bg-slate-100 rounded-lg flex items-center gap-4 mb-4">
             <label class="flex items-center font-medium">
                <input type="checkbox" id="update-all-select-all" class="h-4 w-4 mr-2">
                Selecionar Todos
            </label>
            <select id="update-all-bulk-action-select" class="p-2 border rounded-lg bg-white text-sm">
                <option value="">-- Ação em Massa --</option>
                <optgroup label="Divergências">
                    <option value="update">Atualizar para GIAP</option>
                    <option value="keep">Manter no Sistema</option>
                </optgroup>
                 <optgroup label="Não Encontrados">
                    <option value="mark-for-check">Marcar p/ Checagem Manual</option>
                </optgroup>
            </select>
            <button id="update-all-bulk-apply-btn" class="bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700">Aplicar</button>
        </div>
    `;

    itemsToReview.forEach((item, index) => {
        const { systemItem, giapItem, type } = item;
        
        let header, detailsHtml, bgColor, actionSelect;
        
        if (type === 'divergence') {
            const { divergences } = item;
            bgColor = 'bg-yellow-50 border-yellow-300';
            header = `<span class="text-yellow-700 font-bold">⚠️ DIVERGÊNCIA ENCONTRADA</span> (Tombo: ${escapeHtml(systemItem.Tombamento)})`;
            
            const divergenceList = Object.keys(divergences).filter(k => divergences[k]).map(k => {
                 let sysVal = systemItem[k] || systemItem[k.charAt(0).toUpperCase() + k.slice(1)] || 'N/D';
                 let giapVal = giapItem[k] || giapItem[k.charAt(0).toUpperCase() + k.slice(1)] || 'N/D';
                 if (k === 'desc') {
                     sysVal = systemItem.Descrição;
                     giapVal = giapItem.Descrição || giapItem.Espécie;
                 }
                 
                 return `<li class="text-sm"><strong>${k.charAt(0).toUpperCase() + k.slice(1)}:</strong> Sistema: <span class="text-red-600 font-semibold">${escapeHtml(sysVal)}</span> ➔ GIAP: <span class="text-green-600 font-semibold">${escapeHtml(giapVal)}</span></li>`;
            }).join('');
            
            detailsHtml = `
                <p class="text-sm">O item existe em ambos, mas os dados não batem:</p>
                <ul class="list-disc pl-5 mt-2 space-y-1">${divergenceList}</ul>
            `;

            actionSelect = `
                <select class="update-choice w-full p-2 border rounded-lg bg-white" data-id="${systemItem.id}" data-type="divergence">
                    <option value="update" selected>Atualizar para dados do GIAP</option>
                    <option value="keep">Manter dados atuais do Sistema</option>
                </select>
            `;
            
        } else if (type === 'not_found') {
            bgColor = 'bg-red-50 border-red-300';
            header = `<span class="text-red-700 font-bold">❌ NÃO ENCONTRADO NO GIAP</span> (Tombo: ${escapeHtml(systemItem.Tombamento)})`;
            
            detailsHtml = `
                <p class="text-sm">O Tombo **${escapeHtml(systemItem.Tombamento)}** existe no Sistema (**${escapeHtml(systemItem.Unidade)}**) mas não foi encontrado na Planilha GIAP.</p>
                <p class="text-xs mt-2">Pode ter sido baixado, transferido para outra planilha ou é um erro de digitação no Tombo do sistema.</p>
            `;

            actionSelect = `
                <select class="update-choice-notfound w-full p-2 border rounded-lg bg-white" data-id="${systemItem.id}" data-type="not_found">
                    <option value="mark-for-check" selected>Marcar p/ Checagem Manual</option>
                    <option value="ignore">Ignorar por enquanto</option>
                </select>
            `;
        }

        html += `
            <div class="p-4 border-l-4 rounded-r-lg shadow-sm ${bgColor}">
                <div class="flex items-start justify-between">
                    <div>
                        <h4 class="font-semibold">${header}</h4>
                        <p class="text-xs text-slate-500">${escapeHtml(systemItem.Descrição)} (${escapeHtml(systemItem.Unidade)})</p>
                    </div>
                    <input type="checkbox" class="update-all-checkbox h-4 w-4 ml-4 mt-1" data-id="${systemItem.id}" checked>
                </div>
                <div class="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                    <div class="md:col-span-2">${detailsHtml}</div>
                    <div>
                        <label class="block text-sm font-medium mb-1">Ação a ser Aplicada</label>
                        ${actionSelect}
                    </div>
                </div>
            </div>
        `;
    });

    listContainer.innerHTML = html;
}

/**
 * Manipulador de clique para o botão "Confirmar" do novo modal.
 */
async function handleUpdateAllConfirm() {
    const listItems = DOM.updateAllList.querySelectorAll('.update-all-checkbox:checked');
    if (listItems.length === 0) return showNotification('Selecione pelo menos um item para processar.', 'warning');
    
    showOverlay(`Processando ${listItems.length} ações de auditoria...`);
    DOM.updateAllGiapModal.classList.add('hidden');
    
    const batch = writeBatch(db);
    const { patrimonioFullList, giapMapAllItems } = getState();
    let actionsCount = 0;
    
    listItems.forEach(checkbox => {
        const id = checkbox.dataset.id;
        const row = checkbox.closest('div[class*="border-l-4"]');
        const select = row.querySelector('.update-choice, .update-choice-notfound');
        const action = select ? select.value : 'ignore';
        
        const systemItem = patrimonioFullList.find(i => i.id === id);
        if (!systemItem) return;
        
        const docRef = doc(db, 'patrimonio', id);
        const tombo = normalizeTombo(systemItem.Tombamento);
        const giapItem = giapMapAllItems.get(tombo);
        
        if (action === 'update' && giapItem) {
            // Ação: Atualizar para dados do GIAP (Divergência)
            const changes = {
                Descrição: giapItem.Descrição || giapItem.Espécie,
                Localização: giapItem.Localização || '',
                Fornecedor: giapItem['Nome Fornecedor'] || '',
                NF: giapItem.NF || '',
                'Tipo Entrada': giapItem['Tipo Entrada'] || '',
                Unidade_Planilha: giapItem['Unidade'] || '',
                Observação: `[Auditoria: Atualizado p/ GIAP] ${systemItem.Observação || ''}`,
                updatedAt: serverT()
            };
            batch.update(docRef, changes);
            actionsCount++;
        } else if (action === 'keep') {
            // Ação: Manter dados atuais (Divergência)
            const changes = {
                Observação: `[Auditoria: Manter Sistema] ${systemItem.Observação || ''}`,
                updatedAt: serverT()
            };
            batch.update(docRef, changes);
            actionsCount++;
        } else if (action === 'mark-for-check') {
            // Ação: Marcar para checagem manual (Não encontrado)
            const changes = {
                // Adiciona uma nova flag para facilitar a filtragem na aba de edição
                Auditoria_Status: 'Checagem Manual (Tombo Perdido)',
                Observação: `[Auditoria: Tombo não encontrado no GIAP - Verificar] ${systemItem.Observação || ''}`,
                updatedAt: serverT()
            };
            batch.update(docRef, changes);
            actionsCount++;
        }
        // 'ignore' não faz nada no batch
    });

    if (actionsCount === 0) {
        hideOverlay();
        return showNotification('Nenhuma ação foi selecionada para salvar. Operação cancelada.', 'info');
    }

    try {
        await batch.commit();
        await idb.metadata.clear();
        showNotification(`${actionsCount} ações de auditoria salvas! Recarregando...`, 'success');
        loadData(true);
    } catch (e) {
        hideOverlay();
        showNotification('Erro ao salvar ações de auditoria.', 'error');
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
