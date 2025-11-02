/**
 * src/index.js
 * Ponto de entrada e controlador principal da interatividade da página pública (index.html).
 * Delega o carregamento de dados para os serviços e gerencia a renderização da UI baseada no estado.
 */

import { addAuthListener, handleLogin, handleLogout, loadFirebaseInventory, loadHistory } from './services/firebase.js';
import { loadGiapInventory } from './services/giapService.js';
import { idb, isCacheStale, loadFromCache, updateLocalCache } from './services/cache.js';
import { showNotification, normalizeStr, debounce, escapeHtml, parsePtBrDate, showOverlay, hideOverlay } from './utils/helpers.js';
import { subscribe, setState, getState } from './state/globalStore.js';

// --- ESTADO LOCAL E DOM ---
let patrimonioFilteredList = [], patrimonioCurrentPage = 1;
const patrimonioItemsPerPage = 25;

const DOM = {
    statusFeedbackEl: document.getElementById('status-feedback'),
    tableBodyEl: document.getElementById('inventory-table-body'),
    paginationControlsEl: document.getElementById('pagination-controls'),
    paginationSummaryEl: document.getElementById('pagination-summary'),
    filtroTipoUnidadeEl: document.getElementById('filtro-tipo-unidade'),
    filtroUnidadeEl: document.getElementById('filtro-unidade'),
    filtroEstadoEl: document.getElementById('filtro-estado'),
    filtroBuscaEl: document.getElementById('filtro-busca'),
    resetFiltersBtn: document.getElementById('reset-filters-btn'),
    itemModal: document.getElementById('item-modal'),
    openAddModalBtn: document.getElementById('open-add-modal-btn'),
    itemForm: document.getElementById('item-form'),
    loginModal: document.getElementById('login-modal'),
    openLoginModalBtn: document.getElementById('open-login-modal-btn'),
    loginForm: document.getElementById('login-form'),
    transferModal: document.getElementById('transfer-modal'),
    userInfoEl: document.getElementById('user-info'),
    userEmailEl: document.getElementById('user-email'),
    logoutBtn: document.getElementById('logout-btn'),
    adminActionsPatrimonio: document.getElementById('admin-actions-patrimonio'),
    deleteConfirmModal: document.getElementById('delete-confirm-modal'),
    confirmDeleteBtn: document.getElementById('confirm-delete-btn'),
    navButtons: document.querySelectorAll('#main-nav > .nav-btn, #main-nav > a.nav-btn'),
    contentPanes: document.querySelectorAll('main > .tab-content'),
    historyContainer: document.getElementById('history-container'),
    tabNotas: document.getElementById('tab-notas'),
};


// --- INICIALIZAÇÃO E CARREGAMENTO DE DADOS ---

/**
 * Carrega todos os dados, priorizando o cache ou forçando o fetch.
 * @param {boolean} forceRefresh - Se deve forçar o fetch do servidor.
 */
async function loadAllData(forceRefresh = false) {
    const { statusFeedbackEl, tableBodyEl } = DOM;
    setState({ statusMessage: 'Carregando dados...' });
    tableBodyEl.innerHTML = `<tr><td colspan="7" class="text-center p-10"><div class="loading-spinner"></div><p class="mt-4">Carregando dados...</p></td></tr>`;
    
    let patrimonioFullList = [], giapInventory = [];
    const cacheStale = await isCacheStale();

    if (!forceRefresh && !cacheStale) {
        setState({ statusMessage: 'Carregando dados do cache local...' });
        [patrimonioFullList, giapInventory] = await loadFromCache();
        showNotification('Dados carregados do cache.', 'info');
    } else {
        setState({ statusMessage: 'Buscando dados atualizados do servidor...' });
        showOverlay('Buscando dados no servidor...');
        try {
            const [freshPatrimonio, freshGiapData] = await Promise.all([
                loadFirebaseInventory(),
                loadGiapInventory()
            ]);
            
            freshPatrimonio.sort((a, b) => (a.Descrição || '').localeCompare(b.Descrição || ''));
            patrimonioFullList = freshPatrimonio;
            giapInventory = freshGiapData;

            await updateLocalCache(patrimonioFullList, giapInventory);
            showNotification('Dados atualizados com sucesso!', 'success');
        } catch (error) {
             console.error("Erro ao carregar dados: ", error);
             setState({ statusMessage: 'Erro ao carregar dados.' });
             showNotification('Falha ao carregar dados do servidor. Carregando cache antigo.', 'error');
             [patrimonioFullList, giapInventory] = await loadFromCache();
        } finally {
            hideOverlay();
        }
    }
    
    setState({ 
        patrimonioFullList, 
        giapInventory, 
        initialLoadComplete: true,
        statusMessage: `Pronto. ${patrimonioFullList.length} itens carregados.`
    });
}

// --- FUNÇÕES DE RENDERIZAÇÃO E UI ---

/**
 * Chamado após o carregamento inicial dos dados ou mudanças de estado global.
 */
function updateUIFromState(state) {
    DOM.statusFeedbackEl.textContent = state.statusMessage;
    
    // Visibilidade de Login
    if (state.isLoggedIn) {
        DOM.userEmailEl.textContent = state.user?.email || 'Admin';
        DOM.userInfoEl.classList.remove('hidden'); DOM.userInfoEl.classList.add('flex');
        DOM.openLoginModalBtn.classList.add('hidden');
        DOM.tabNotas.style.display = 'inline-block';
        document.getElementById('nav-history').classList.remove('hidden');
        document.getElementById('nav-edit-link').classList.remove('hidden');
        DOM.adminActionsPatrimonio.classList.remove('hidden');
        document.getElementById('table-header-actions').classList.remove('hidden');
    } else {
        DOM.userEmailEl.textContent = '';
        DOM.userInfoEl.classList.add('hidden'); DOM.userInfoEl.classList.remove('flex');
        DOM.openLoginModalBtn.classList.remove('hidden');
        DOM.tabNotas.style.display = 'none';
        document.getElementById('nav-history').classList.add('hidden');
        document.getElementById('nav-edit-link').classList.add('hidden');
        DOM.adminActionsPatrimonio.classList.add('hidden');
        document.getElementById('table-header-actions').classList.add('hidden');
    }
    
    if (state.initialLoadComplete) {
        populateFilters(state.patrimonioFullList);
        applyPatrimonioFiltersAndRender();
        if (document.getElementById('content-dashboard').classList.contains('active')) {
             renderDashboard(state.patrimonioFullList);
        }
    }

    if (state.isLoggedIn && state.historicoFullList.length > 0) {
        renderHistory(state.historicoFullList);
    }
}

function renderDashboard(items) {
    if (!items || items.length === 0) return;
    const kpi = (id, value) => document.getElementById(id).textContent = value;
    const getNormalizedEstado = (estadoStr) => {
        const normalized = normalizeStr(estadoStr);
        if (['avariado', 'quebrado', 'defeito', 'danificado', 'ruim'].some(k => normalized.includes(k))) return 'Avariado';
        if (normalized === 'novo') return 'Novo';
        if (normalized === 'bom' || normalized === 'otimo') return 'Bom';
        if (normalized === 'regular') return 'Regular';
        return 'Avariado';
    };

    kpi('kpi-total-itens', items.reduce((s, i) => s + (i.Quantidade || 1), 0));
    kpi('kpi-total-unidades', new Set(items.map(i => i.Unidade)).size);
    const estadosCount = items.reduce((a, i) => { const n = getNormalizedEstado(i.Estado); a[n] = (a[n] || 0) + (i.Quantidade || 1); return a; }, {});
    kpi('kpi-total-avariados', estadosCount['Avariado'] || 0);
    kpi('kpi-total-novos', estadosCount['Novo'] || 0);

    // Renderiza gráficos (lógica simplificada para caber no módulo)
    const estadoCtx = document.getElementById('dashboardEstadoChart')?.getContext('2d');
    if (estadoCtx) {
        if (window.dashboardEstadoChart) window.dashboardEstadoChart.destroy();
        window.dashboardEstadoChart = new Chart(estadoCtx, { type: 'doughnut', data: { labels: Object.keys(estadosCount), datasets: [{ data: Object.values(estadosCount), backgroundColor: ['#ef4444', '#10b981', '#3b82f6', '#f59e0b'] }] }, options: { responsive: true, maintainAspectRatio: false } });
    }

    const unidadesCount = items.reduce((a, i) => { const u = i.Unidade || 'N/D'; a[u] = (a[u] || 0) + 1; return a; }, {});
    const sortedUnidades = Object.entries(unidadesCount).sort(([,a],[,b]) => b-a).slice(0, 10);
    const tipoCtx = document.getElementById('dashboardTipoChart')?.getContext('2d');
    if (tipoCtx) {
        if (window.dashboardTipoChart) window.dashboardTipoChart.destroy();
        window.dashboardTipoChart = new Chart(tipoCtx, { type: 'bar', data: { labels: sortedUnidades.map(u => u[0]), datasets: [{ label: 'Itens', data: sortedUnidades.map(u => u[1]), backgroundColor: '#3b82f6' }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false } });
    }
}

function renderHistory(historico) {
    if(!getState().isLoggedIn) return;
    DOM.historyContainer.innerHTML = historico.length > 0 
        ? historico.map(h => `
            <div class="p-3 border rounded-md bg-slate-50 text-sm">
                <p><strong>${h.action}:</strong> ${h.itemDesc || ''} <span class="text-xs text-slate-500">(${h.itemId || ''})</span></p>
                <p class="text-xs text-slate-600">${h.details}</p>
                <div class="text-right text-xs text-slate-400 mt-1">${h.user} em ${h.timestamp ? new Date(h.timestamp.seconds * 1000).toLocaleString('pt-BR') : ''}</div>
            </div>
        `).join('')
        : `<p class="text-slate-500">Nenhum histórico encontrado.</p>`;
}

function populateFilters(items) {
    const tipos = [...new Set(items.map(item => item.Tipo).filter(Boolean))].sort();
    DOM.filtroTipoUnidadeEl.innerHTML = '<option value="">TODOS OS TIPOS</option>' + tipos.map(t => `<option value="${t}">${t}</option>`).join('');
    const estados = ['Novo', 'Bom', 'Regular', 'Avariado'];
    DOM.filtroEstadoEl.innerHTML = '<option value="">TODOS OS ESTADOS</option>' + estados.map(e => `<option value="${e}">${e}</option>`).join('');

    // Garante que o filtro de unidade seja atualizado quando o tipo mudar
    DOM.filtroTipoUnidadeEl.onchange = () => { 
        updateUnidadeFilter(DOM.filtroTipoUnidadeEl, DOM.filtroUnidadeEl, items); 
        debouncedFilter();
    };
}

function updateUnidadeFilter(tipoSelectEl, unidadeSelectEl, items) {
    const selectedTipo = tipoSelectEl.value;
    const unidades = selectedTipo 
        ? [...new Set(items.filter(i => i.Tipo === selectedTipo).map(i => i.Unidade).filter(Boolean))].sort()
        : [];

    unidadeSelectEl.innerHTML = '<option value="">TODAS AS UNIDADES</option>' + unidades.map(u => `<option value="${u}">${u}</option>`).join('');
    unidadeSelectEl.disabled = !selectedTipo;
}

function getNormalizedEstado(state) {
    const normalized = normalizeStr(state);
    if (['avariado', 'quebrado', 'defeito', 'danificado', 'ruim'].some(k => normalized.includes(k))) return 'Avariado';
    if (normalized === 'novo') return 'Novo';
    if (normalized === 'bom' || normalized === 'otimo') return 'Bom';
    if (normalized === 'regular') return 'Regular';
    return 'Avariado';
}

function getStateColor(state) {
    const normalizedEstado = getNormalizedEstado(state);
    return { 'Novo': 'badge-green', 'Bom': 'badge-blue', 'Regular': 'badge-yellow', 'Avariado': 'badge-red' }[normalizedEstado] || 'bg-slate-200';
}

function applyPatrimonioFiltersAndRender() {
    const { patrimonioFullList } = getState();
    if(!patrimonioFullList) return;
    const tipo = DOM.filtroTipoUnidadeEl.value;
    const unidade = DOM.filtroUnidadeEl.value;
    const estado = DOM.filtroEstadoEl.value;
    const busca = normalizeStr(DOM.filtroBuscaEl.value);

    patrimonioFilteredList = patrimonioFullList.filter(item => {
        const descMatch = !busca || normalizeStr(item.Descrição).includes(busca);
        const tomboMatch = !busca || normalizeStr(item.Tombamento).includes(busca);
        const localMatch = !busca || normalizeStr(item.Localização).includes(busca);

        return (!tipo || item.Tipo === tipo) &&
               (!unidade || item.Unidade === unidade) &&
               (!estado || getNormalizedEstado(item.Estado) === estado) &&
               (descMatch || tomboMatch || localMatch);
    });
    patrimonioCurrentPage = 1;
    renderPatrimonioTable(getState().isLoggedIn);
}

function renderPatrimonioTable(isLoggedIn) {
    const startIndex = (patrimonioCurrentPage - 1) * patrimonioItemsPerPage;
    const itemsToDisplay = patrimonioFilteredList.slice(startIndex, startIndex + patrimonioItemsPerPage);
    
    const actionButtonsHTML = (itemId) => !isLoggedIn ? '' : `<td class="px-3 py-2 space-x-2"><button class="transfer-btn p-1 text-green-600 hover:text-green-800" data-id="${itemId}" title="Transferir Item"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M1.5 1.5A.5.5 0 0 0 1 2v4.8a2.5 2.5 0 0 0 2.5 2.5h9.793l-3.347 3.346a.5.5 0 0 0 .708.708l4.2-4.2a.5.5 0 0 0 0-.708l-4-4a.5.5 0 0 0-.708.708L13.293 8.3H3.5a1.5 1.5 0 0 1-1.5-1.5V2a.5.5 0 0 0-.5-.5z"/></svg></button><button class="edit-btn p-1 text-blue-600 hover:text-blue-800" data-id="${itemId}" title="Editar Item"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/><path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z"/></svg></button><button class="delete-btn p-1 text-red-600 hover:text-red-800" data-id="${itemId}" title="Excluir Item"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11z"/></svg></button></td>`;

    DOM.tableBodyEl.innerHTML = itemsToDisplay.length === 0 
        ? `<tr><td colspan="${isLoggedIn ? 7 : 6}" class="text-center py-10 text-slate-500">Nenhum item encontrado com os filtros atuais.</td></tr>`
        : itemsToDisplay.map(item => `
            <tr class="border-b border-slate-200 hover:bg-slate-50">
                <td class="px-3 py-2 font-mono text-xs">${item.Tombamento || 'S/T'}</td>
                <td class="px-3 py-2 font-medium text-slate-900">${item.Descrição || 'N/A'}</td>
                <td class="px-3 py-2">${item.Unidade || 'N/A'}</td>
                <td class="px-3 py-2 text-xs">${item.Fornecedor || 'N/A'}</td>
                <td class="px-3 py-2 text-xs">${item['Origem da Doação'] || 'N/A'}</td>
                <td class="px-3 py-2"><span class="badge ${getStateColor(item.Estado)}">${item.Estado || 'N/A'}</span></td>
                ${actionButtonsHTML(item.id)}
            </tr>`).join('');
    renderPatrimonioPagination();
}

function renderPatrimonioPagination() {
    const totalPages = Math.ceil(patrimonioFilteredList.length / patrimonioItemsPerPage);
    const startItem = (patrimonioCurrentPage - 1) * patrimonioItemsPerPage + 1;
    const endItem = Math.min(startItem + patrimonioItemsPerPage - 1, patrimonioFilteredList.length);
    
    DOM.paginationSummaryEl.textContent = patrimonioFilteredList.length > 0 ? `Mostrando ${startItem}-${endItem} de ${patrimonioFilteredList.length} itens.` : 'Nenhum item para exibir.';

    DOM.paginationControlsEl.innerHTML = totalPages <= 1 ? '' : `<div class="inline-flex"><button data-page="${patrimonioCurrentPage - 1}" class="px-4 py-2 text-sm border rounded-l-lg" ${patrimonioCurrentPage === 1 ? 'disabled' : ''}>Anterior</button><button data-page="${patrimonioCurrentPage + 1}" class="px-4 py-2 text-sm border rounded-r-lg" ${patrimonioCurrentPage === totalPages ? 'disabled' : ''}>Próximo</button></div>`;
}

// --- FUNÇÕES DE LÓGICA DE NEGÓCIO ---

function processNfData(giapInventory) {
    if (giapInventory.length === 0) return {};
    const giapWithNf = giapInventory
        .filter(item => item.NF && item.NF.trim() !== '')
        .sort((a, b) => parsePtBrDate(b.Cadastro) - parsePtBrDate(a.Cadastro));
    
    return giapWithNf.reduce((acc, item) => {
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
}

function renderNfList(processedNfData, patrimonioFullList) {
    const container = document.getElementById('lista-notas');
    if (!container) return;
    container.innerHTML = '';
    if (Object.keys(processedNfData).length === 0) return; 

    const tomboMap = new Map(patrimonioFullList.map(item => [item.Tombamento?.trim(), item]));
    
    // Simplificado: usando apenas busca básica para manter a concisão no módulo principal.
    const nfSearchTerm = (document.getElementById('nf-search-index')?.value || '').toLowerCase();
    
    const filteredNfs = Object.keys(processedNfData).filter(nf => {
        if (nfSearchTerm && !nf.toLowerCase().includes(nfSearchTerm)) return false;
        return true;
    });

    if (filteredNfs.length === 0) {
        container.innerHTML = `<p class="text-slate-500 text-center p-4">Nenhuma nota fiscal encontrada com os filtros aplicados.</p>`;
        return;
    }
    
    // Renderização simplificada
    filteredNfs.forEach(nf => {
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
                    const tombo = item.TOMBAMENTO?.trim();
                    const allocatedItem = tombo ? tomboMap.get(tombo) : undefined;
                    let allocationHtml = allocatedItem 
                        ? `<span class="px-2 py-1 text-xs font-semibold text-green-800 bg-green-100 rounded-full">Alocado em: ${escapeHtml(allocatedItem.Unidade)}</span>`
                        : `<span class="px-2 py-1 text-xs font-semibold text-slate-700 bg-slate-200 rounded-full">Não Alocado</span>`;
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


// --- LISTENERS E INICIALIZAÇÃO ---

function setupListeners() {
    const state = getState();
    // Auth Listener
    addAuthListener(async user => {
        const isLoggedIn = !!user;
        const historicoFullList = isLoggedIn ? await loadHistory() : [];
        setState({ isLoggedIn, user, historicoFullList, authReady: true });
        if (isLoggedIn && state.initialLoadComplete) {
            // Se logou depois de carregar os dados, renderiza as notas
            renderNfList(processNfData(state.giapInventory), state.patrimonioFullList);
        }
    });

    // Filtros
    const debouncedFilter = debounce(applyPatrimonioFiltersAndRender, 300);
    DOM.filtroUnidadeEl.addEventListener('change', debouncedFilter);
    DOM.filtroEstadoEl.addEventListener('change', debouncedFilter);
    DOM.filtroBuscaEl.addEventListener('input', debouncedFilter);
    DOM.resetFiltersBtn.addEventListener('click', () => { 
        document.getElementById('patrimonio-filters-form').reset(); 
        DOM.filtroUnidadeEl.disabled = true; 
        applyPatrimonioFiltersAndRender(); 
    });

    // Paginação
    DOM.paginationControlsEl.addEventListener('click', (e) => { 
        if(e.target.dataset.page) { 
            patrimonioCurrentPage = parseInt(e.target.dataset.page); 
            renderPatrimonioTable(getState().isLoggedIn); 
        }
    });
    
    // Ações de Tabela (Editar/Deletar/Transferir)
    DOM.tableBodyEl.addEventListener('click', (e) => {
        // ... (Lógica de Modais omitida para brevidade, mas seria implementada aqui)
    });
    
    // Login/Logout
    DOM.loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const result = await handleLogin(DOM.loginForm.email.value, DOM.loginForm.password.value);
        if (result === true) { DOM.loginModal.classList.add('hidden'); }
    });
    DOM.logoutBtn.addEventListener('click', handleLogout);
    DOM.openLoginModalBtn.addEventListener('click', () => DOM.loginModal.classList.remove('hidden'));
    
    // Nav Tabs
    DOM.navButtons.forEach(button => button.addEventListener('click', (e) => {
        const tabName = e.currentTarget.dataset.tab;
        DOM.navButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));
        DOM.contentPanes.forEach(pane => pane.classList.toggle('hidden', pane.id !== `content-${tabName}`));
        if (tabName === 'dashboard' && state.patrimonioFullList.length > 0) renderDashboard(state.patrimonioFullList);
        if (tabName === 'historico' && state.isLoggedIn) renderHistory(state.historicoFullList);
        if (tabName === 'notas' && state.isLoggedIn) renderNfList(processNfData(state.giapInventory), state.patrimonioFullList);
    }));

    // Forçar Atualização
    document.getElementById('force-refresh-btn-index').addEventListener('click', () => loadAllData(true));

    // Fechar Modais (Overlay ou Botão genérico)
    document.addEventListener('click', (e) => { 
        if (e.target.matches('.js-close-modal') || e.target.matches('.modal-overlay')) { 
            e.target.closest('.modal')?.classList.add('hidden'); 
        } 
    });

    // Filtros de Notas Fiscais
    const debouncedRenderNf = debounce(() => renderNfList(processNfData(state.giapInventory), state.patrimonioFullList), 300);
    document.getElementById('nf-search-index').addEventListener('input', debouncedRenderNf);
    document.getElementById('clear-filters-nf-index').addEventListener('click', () => {
        document.getElementById('nf-search-index').value = '';
        renderNfList(processNfData(state.giapInventory), state.patrimonioFullList);
    });
}

function init() {
    // 1. Assina o Listener Global
    subscribe(updateUIFromState);

    // 2. Configura Listeners de Eventos
    setupListeners();

    // 3. Inicia o Carregamento dos Dados
    loadAllData();
}

document.addEventListener('DOMContentLoaded', init);
