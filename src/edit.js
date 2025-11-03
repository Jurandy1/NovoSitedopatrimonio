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

    // Aba: Conciliar Itens
    conciliarFilterTipo: document.getElementById('filter-tipo'),
    conciliarFilterUnidade: document.getElementById('filter-unidade'),
    loadConciliarBtn: document.getElementById('load-conciliar'),
    systemListFilter: document.getElementById('system-list-filter'),
    systemList: document.getElementById('system-list'),
    giapListFilter: document.getElementById('giap-list-filter'),
    giapList: document.getElementById('giap-list'),
    giapListUnitName: document.getElementById('giap-list-unit-name'),
    quickActions: document.getElementById('quick-actions'),
    createdLinks: document.getElementById('created-links'),
    saveLinksBtn: document.getElementById('save-links'),
    clearSelectionsBtn: document.getElementById('clear-selections'),
};

// --- ESTADO LOCAL/TRANSITÓRIO ---
// ... existing code ...
// ... existing code ...
function updateUIFromState(state) {
// ... existing code ...
        if (state.initialLoadComplete) {
            // CORREÇÃO: Chama as funções de população que agora têm código
            populateEditableInventoryTab();
            populateUnitMappingTab(); // AGORA IMPLEMENTADO
            populateReconciliationTab(); // AGORA IMPLEMENTADO
            populatePendingTransfersTab(); // Ainda está vazia
            // ... outras abas
// ... existing code ...
// ... existing code ...
function renderEditableTable() {
    const tableBody = DOM.editTableBody;
    // Limita a 200 itens para performance. Filtros mais específicos são necessários.
// ... existing code ...
// ... existing code ...
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
    DOM.savedMappingsContainer.innerHTML = Object.entries(unitMapping).map(([systemUnit, giapUnits]) => {
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


// --- LISTENERS ---

function setupListeners() {
    // Auth Listener
    addAuthListener(user => {
// ... existing code ...
// ... existing code ...
    // Navegação por Abas
    DOM.navButtons.forEach(button => {
        button.addEventListener('click', (e) => {
// ... existing code ...
// ... existing code ...
    // --- Listeners da Aba: Inventário Editável ---
    DOM.editTableBody.addEventListener('change', (e) => {
        // ... (Lógica para marcar item como 'dirty' e salvar no estado local/transitorio)
// ... existing code ...
// ... existing code ...
    DOM.saveAllChangesBtn.addEventListener('click', async () => {
        if (dirtyItems.size === 0) return;
        showOverlay(`Salvando ${dirtyItems.size} alterações...`);
        // CORREÇÃO: Usar o 'db' importado
        const batch = writeBatch(db); 
        
        dirtyItems.forEach((changes, id) => {
            const itemRef = doc(db, 'patrimonio', id);
            batch.update(itemRef, { ...changes, lastModified: serverTimestamp() });
        });

        try {
            await batch.commit();
            dirtyItems.clear();
            showNotification(`${dirtyItems.size} alterações salvas com sucesso!`, 'success');
            // Recarregar dados para refletir mudanças
            await loadData(true); 
        } catch (error) {
            console.error("Erro ao salvar alterações:", error);
            showNotification('Erro ao salvar alterações.', 'error');
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

        if (!confirm(`Tem certeza que deseja excluir o mapeamento para "${systemUnit}"?`)) {
            return;
        }

        showOverlay('Excluindo mapeamento...');
        try {
            const mappingRef = doc(db, 'config', 'unitMapping');
            
            // Para excluir um campo, usamos updateDoc com deleteField()
            await updateDoc(mappingRef, {
                [`mappings.${systemUnit}`]: deleteField()
            });

            // Atualiza o estado local
            const currentMapping = { ...getState().unitMapping };
            delete currentMapping[systemUnit];
            setState({ unitMapping: currentMapping });
            renderSavedMappings(currentMapping); // Re-renderiza a lista

            showNotification('Mapeamento excluído!', 'success');
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

        // 1. Popula Itens do Sistema (S/T)
        const systemItems = patrimonioFullList.filter(item => 
            item.Unidade === selectedUnit && 
            (item.Tombamento === 'S/T' || !item.Tombamento)
        ).sort((a, b) => (a.Descrição || '').localeCompare(b.Descrição || ''));
        
        DOM.systemList.innerHTML = systemItems.length > 0
            ? systemItems.map(item => `
                <div class="reconciliation-list-item p-2 border-b" data-id="${item.id}" data-desc="${escapeHtml(item.Descrição)}">
                    <p class="font-semibold">${escapeHtml(item.Descrição)}</p>
                    <p class="text-xs text-slate-500">${escapeHtml(item.Localização) || 'Sem local'}</p>
                </div>
            `).join('')
            : '<p class="p-4 text-slate-500 text-center">Nenhum item "S/T" encontrado para esta unidade.</p>';

        // 2. Popula Itens do GIAP (Disponíveis)
        const giapUnitsForSystemUnit = unitMapping[selectedUnit] || [];
        DOM.giapListUnitName.textContent = giapUnitsForSystemUnit.join(', ') || 'Nenhuma unidade GIAP ligada';
        
        const giapItems = [];
        giapMap.forEach((item, tombo) => {
            // Inclui se a unidade do GIAP está mapeada para a unidade do sistema E
            // se o tombo não está na lista de "já conciliados"
            if (giapUnitsForSystemUnit.includes(item.Unidade) && !reconciledUnits.includes(tombo)) {
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
// ... existing code ...

