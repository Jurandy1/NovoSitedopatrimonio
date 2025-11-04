// /src/admin/tabInventario.js
// Lógica da aba "Inventário Editável" (content-edicao).

// INÍCIO DA ALTERAÇÃO: Adicionado 'addDoc' para criar novos itens
import { db, serverT, writeBatch, doc, updateDoc, deleteDoc, collection, addDoc } from '../services/firebase.js';
// FIM DA ALTERAÇÃO
import { getState, setState } from '../state/globalStore.js';
import { showNotification, showOverlay, hideOverlay, normalizeStr, debounce, escapeHtml, normalizeTombo } from '../utils/helpers.js';
import { idb } from '../services/cache.js';

// --- ESTADO LOCAL/TRANSITÓRIO ---
let dirtyItems = new Map();
let currentEditFilter = { tipo: '', unidade: '', estado: '', descricao: '' };

const DOM_EDIT_INV = {
    editTableBody: document.getElementById('edit-table-body'),
    saveAllChangesBtn: document.getElementById('save-all-changes-btn'),
    filtroTipo: document.getElementById('edit-filter-tipo'),
    filtroUnidade: document.getElementById('edit-filter-unidade'),
    filtroEstado: document.getElementById('edit-filter-estado'),
    filtroDescricao: document.getElementById('edit-filter-descricao'),
    deleteSelectedBtn: document.getElementById('delete-selected-btn'),
    deleteSelectedCount: document.getElementById('delete-selected-count'),
    selectAllCheckbox: document.getElementById('select-all-checkbox'),
    deleteConfirmModal: document.getElementById('delete-confirm-modal-edit'),
    // INÍCIO DA ALTERAÇÃO: Adicionados elementos do DOM
    unitItemCount: document.getElementById('unit-item-count'),
    addItemToUnitBtn: document.getElementById('add-item-to-unit-btn'),
    addItemModal: document.getElementById('add-item-modal'),
    // FIM DA ALTERAÇÃO
};

// --- FUNÇÕES DE UTILITY ---

const getNormalizedEstado = (state) => {
    const normalized = normalizeStr(state);
    if (['avariado', 'quebrado', 'defeito', 'danificado', 'ruim'].some(k => normalized.includes(k))) return 'Avariado';
    if (normalized.startsWith('novo')) return 'Novo';
    if (normalized.startsWith('bom') || normalized.startsWith('otimo')) return 'Bom';
    if (normalized.startsWith('regular')) return 'Regular';
    return 'N/D';
};

// --- FUNÇÕES DE RENDERIZAÇÃO ---

/**
 * Popula filtros e renderiza a tabela inicial (sem filtro de unidade).
 */
export function populateEditableInventoryTab() {
    const { patrimonioFullList } = getState();

    // Popula Tipos
    const tiposMap = new Map();
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!tiposMap.has(normalized)) {
            tiposMap.set(normalized, tipo.trim());
        }
    });
    const tipos = [...tiposMap.values()].sort();
    const estados = ['Novo', 'Bom', 'Regular', 'Avariado', 'N/D'];
    
    DOM_EDIT_INV.filtroTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    DOM_EDIT_INV.filtroEstado.innerHTML = '<option value="">Todos os Estados</option>' + estados.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');

    renderEditableTable();
}

/**
 * Renderiza a tabela do inventário editável com base nos filtros
 */
export function renderEditableTable() {
    const { patrimonioFullList } = getState();
    
    const filteredItems = patrimonioFullList.filter(item => {
        const { tipo, unidade, estado, descricao } = currentEditFilter;
        if (tipo && normalizeStr(item.Tipo) !== normalizeStr(tipo)) return false;
        if (unidade && normalizeStr(item.Unidade) !== normalizeStr(unidade)) return false;
        if (estado && getNormalizedEstado(item.Estado) !== estado) return false;
        if (descricao && !normalizeStr(item.Descrição).includes(descricao)) return false;
        return true;
    });

    // Limita a 200 itens para performance
    const itemsToDisplay = filteredItems.slice(0, 200);

    if (itemsToDisplay.length === 0) {
        DOM_EDIT_INV.editTableBody.innerHTML = `<tr><td colspan="14" class="text-center p-10 text-slate-500">Nenhum item encontrado. Use os filtros para refinar sua busca.</td></tr>`;
    } else {
        DOM_EDIT_INV.editTableBody.innerHTML = itemsToDisplay.map(item => `
            <tr id="row-${item.id}" class="${dirtyItems.has(item.id) ? 'is-dirty' : ''}">
                <td class="p-2"><input type="checkbox" class="row-checkbox" data-id="${item.id}"></td>
                <td class="p-2">
                    <button class="save-row-btn p-1 text-green-600 hover:text-green-800" data-id="${item.id}" title="Salvar este item">✔</button>
                    <button class="delete-row-btn p-1 text-red-600 hover:text-red-800" data-id="${item.id}" title="Excluir este item">✖</button>
                </td>
                <td class="p-2"><input type="text" class="w-24 editable-field" data-id="${item.id}" data-field="Tombamento" value="${escapeHtml(item.Tombamento || '')}"></td>
                <!-- INÍCIO DA ALTERAÇÃO: Título do botão de sincronia atualizado -->
                <td class="p-2"><button class="sync-giap-btn p-1 text-blue-600 hover:text-blue-800" data-id="${item.id}" title="Verificar/Sincronizar com Planilha GIAP">🔄</button></td>
                <!-- FIM DA ALTERAÇÃO -->
                <td class="p-2"><input type="text" class="w-64 editable-field" data-id="${item.id}" data-field="Descrição" value="${escapeHtml(item.Descrição || '')}"></td>
                <td class="p-2"><input type="text" class="w-24 editable-field" data-id="${item.id}" data-field="Tipo" value="${escapeHtml(item.Tipo || '')}"></td>
                <td class="p-2"><input type="text" class="w-48 editable-field" data-id="${item.id}" data-field="Unidade" value="${escapeHtml(item.Unidade || '')}"></td>
                <td class="p-2"><input type="text" class="w-32 editable-field" data-id="${item.id}" data-field="Localização" value="${escapeHtml(item.Localização || '')}"></td>
                <td class="p-2"><input type="text" class="w-32 editable-field" data-id="${item.id}" data-field="Fornecedor" value="${escapeHtml(item.Fornecedor || '')}"></td>
                <td class="p-2"><input type="text" class="w-20 editable-field" data-id="${item.id}" data-field="NF" value="${escapeHtml(item.NF || '')}"></td>
                <td class="p-2"><input type="text" class="w-32 editable-field" data-id="${item.id}" data-field="Origem da Doação" value="${escapeHtml(item['Origem da Doação'] || '')}"></td>
                <td class="p-2">
                    <select class="w-28 editable-field" data-id="${item.id}" data-field="Estado">
                        <option value="Novo" ${item.Estado === 'Novo' ? 'selected' : ''}>Novo</option>
                        <option value="Bom" ${item.Estado === 'Bom' ? 'selected' : ''}>Bom</option>
                        <option value="Regular" ${item.Estado === 'Regular' ? 'selected' : ''}>Regular</option>
                        <option value="Avariado" ${item.Estado === 'Avariado' ? 'selected' : ''}>Avariado</option>
                    </select>
                </td>
                <td class="p-2"><input type="number" class="w-16 editable-field" data-id="${item.id}" data-field="Quantidade" value="${item.Quantidade || 1}"></td>
                <td class="p-2"><input type="text" class="w-48 editable-field" data-id="${item.id}" data-field="Observação" value="${escapeHtml(item.Observação || '')}"></td>
            </tr>
        `).join('');
    }
    
    // INÍCIO DA ALTERAÇÃO: Atualiza contador e visibilidade do botão "Adicionar Item"
    if (currentEditFilter.unidade) {
        DOM_EDIT_INV.unitItemCount.textContent = `${filteredItems.length} itens encontrados.`;
        DOM_EDIT_INV.addItemToUnitBtn.classList.remove('hidden');
    } else {
        DOM_EDIT_INV.unitItemCount.textContent = '';
        DOM_EDIT_INV.addItemToUnitBtn.classList.add('hidden');
    }
    // FIM DA ALTERAÇÃO

    // Garante que o contador de exclusão seja atualizado.
    updateDeleteButtonState(); 
}

/**
 * Atualiza o estado do botão de exclusão e a contagem.
 */
function updateDeleteButtonState() {
    const checked = DOM_EDIT_INV.editTableBody.querySelectorAll('.row-checkbox:checked');
    const count = checked.length;
    DOM_EDIT_INV.deleteSelectedCount.textContent = count;
    DOM_EDIT_INV.deleteSelectedBtn.classList.toggle('hidden', count === 0);
}

// --- FUNÇÕES DE AÇÃO ---

/**
 * Salva todas as alterações pendentes (dirtyItems).
 * @param {boolean} shouldReload - Se deve recarregar os dados após salvar.
 */
async function saveAllChanges(shouldReload = true) {
    if (dirtyItems.size === 0) return;
    
    showOverlay(`Salvando ${dirtyItems.size} alterações...`);
    const batch = writeBatch(db); 
    
    const itemsToSave = new Map(dirtyItems);
    dirtyItems.clear();
    DOM_EDIT_INV.saveAllChangesBtn.disabled = true;

    itemsToSave.forEach((changes, id) => {
        const itemRef = doc(db, 'patrimonio', id);
        batch.update(itemRef, { ...changes, updatedAt: serverT() });
    });

    try {
        await batch.commit();
        showNotification(`${itemsToSave.size} alterações salvas com sucesso!`, 'success');
        if (shouldReload) {
             // Força o reset do cache e recarregamento pelo orquestrador
             await idb.metadata.clear(); 
             // O orquestrador (edit.js) chamará loadData(true) se for necessário.
        } else {
            // Atualiza o estado em memória para refletir a mudança
            // Não recarrega o cache, apenas limpa a flag "dirty" da UI
            itemsToSave.forEach((changes, id) => {
                const row = document.getElementById(`row-${id}`);
                if (row) row.classList.remove('is-dirty');
            });
            hideOverlay();
        }
    } catch (error) { 
        console.error("Erro ao salvar alterações:", error);
        showNotification('Erro ao salvar alterações.', 'error');
        // Restaura os itens "sujos" no caso de falha
        dirtyItems = new Map([...itemsToSave, ...dirtyItems]);
        DOM_EDIT_INV.saveAllChangesBtn.disabled = dirtyItems.size > 0;
    } finally {
        if (shouldReload) {
            hideOverlay(); // O reload é feito pelo orquestrador
        }
    }
}

/**
 * Lida com a exclusão de um ou mais itens.
 * @param {Array<string>} ids - IDs dos documentos a serem excluídos.
 */
async function deleteItems(ids) {
    showOverlay(`Excluindo ${ids.length} itens...`);
    
    const batch = writeBatch(db);
    ids.forEach(id => {
        const docRef = doc(db, 'patrimonio', id);
        batch.delete(docRef);
    });

    try {
        await batch.commit();
        showNotification(`${ids.length} item(s) excluído(s) com sucesso!`, 'success');
        await idb.metadata.clear(); 
    } catch (error) {
        console.error("Erro ao excluir itens:", error);
        showNotification('Erro ao excluir itens.', 'error');
    } finally {
        hideOverlay();
    }
}


// --- LISTENERS ---

export function setupInventarioListeners(reloadDataCallback, openSyncModalCallback) {
    // *** CORREÇÃO: patrimonioFullList removido deste escopo ***

    // Listener para filtros
    const debouncedRender = debounce(() => {
        currentEditFilter.descricao = DOM_EDIT_INV.filtroDescricao.value;
        renderEditableTable();
    }, 300);

    DOM_EDIT_INV.filtroTipo.addEventListener('change', () => {
        // *** CORREÇÃO: patrimonioFullList é obtido de getState() AQUI DENTRO ***
        const { patrimonioFullList } = getState();
        const selectedTipo = DOM_EDIT_INV.filtroTipo.value;
        currentEditFilter.tipo = selectedTipo;
        
        // Popula filtro de unidade baseado no tipo
        const unidadesMap = new Map();
        (selectedTipo
            ? patrimonioFullList.filter(i => normalizeStr(i.Tipo) === normalizeStr(selectedTipo)).map(i => i.Unidade).filter(Boolean)
            : []
        ).forEach(unidade => {
            const normalized = normalizeStr(unidade);
            if (!unidadesMap.has(normalized)) {
                unidadesMap.set(normalized, unidade.trim());
            }
        });
        const unidades = [...unidadesMap.values()].sort();
            
        DOM_EDIT_INV.filtroUnidade.innerHTML = '<option value="">Todas as Unidades</option>' + unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        DOM_EDIT_INV.filtroUnidade.disabled = !selectedTipo;
        currentEditFilter.unidade = ''; 
        renderEditableTable();
    });
    
    DOM_EDIT_INV.filtroUnidade.addEventListener('change', () => {
        currentEditFilter.unidade = DOM_EDIT_INV.filtroUnidade.value;
        renderEditableTable();
    });

    DOM_EDIT_INV.filtroEstado.addEventListener('change', () => {
        currentEditFilter.estado = DOM_EDIT_INV.filtroEstado.value;
        renderEditableTable();
    });
    
    DOM_EDIT_INV.filtroDescricao.addEventListener('input', debouncedRender);


    // Listener para mudanças na tabela (marca como "sujo")
    DOM_EDIT_INV.editTableBody.addEventListener('change', (e) => {
        const target = e.target;
        const id = target.dataset.id;
        const field = target.dataset.field;
        let value = target.value;

        if (field === 'Quantidade') value = parseInt(value, 10) || 1;

        if (id && field) {
            const currentChanges = dirtyItems.get(id) || {};
            dirtyItems.set(id, { ...currentChanges, [field]: value });
            document.getElementById(`row-${id}`).classList.add('is-dirty');
            DOM_EDIT_INV.saveAllChangesBtn.disabled = false;
        }
    });

    // Listener para ações da tabela (botões e checkboxes)
    DOM_EDIT_INV.editTableBody.addEventListener('click', async (e) => {
        const { patrimonioFullList } = getState(); // Pega a lista para ações
        const target = e.target.closest('button'); // Garante que estamos pegando o botão
        if (!target) {
            // Se o clique não foi em um botão, pode ter sido no checkbox
            if (e.target.classList.contains('row-checkbox')) {
                updateDeleteButtonState();
            }
            return;
        }
        
        const id = target.dataset.id;

        if (target.classList.contains('save-row-btn')) {
            if (!id || !dirtyItems.has(id)) {
                showNotification('Nenhuma alteração pendente para salvar.', 'warning');
                return;
            }
            
            showOverlay('Salvando item...');
            const changes = dirtyItems.get(id);
            dirtyItems.delete(id);
            DOM_EDIT_INV.saveAllChangesBtn.disabled = dirtyItems.size === 0;

            try {
                const itemRef = doc(db, 'patrimonio', id);
                await updateDoc(itemRef, { ...changes, updatedAt: serverT() });
                document.getElementById(`row-${id}`).classList.remove('is-dirty');

                // ATUALIZAÇÃO: Atualiza o estado local e o cache
                const item = patrimonioFullList.find(i => i.id === id);
                const updatedItem = { ...item, ...changes };
                const index = patrimonioFullList.findIndex(i => i.id === id);
                if(index > -1) {
                    patrimonioFullList[index] = updatedItem;
                    setState({ patrimonioFullList }); 
                }
                await idb.patrimonio.put(updatedItem); 

                showNotification('Item salvo com sucesso!', 'success');
            } catch (error) {
                console.error("Erro ao salvar item:", error);
                showNotification('Erro ao salvar item.', 'error');
            } finally {
                hideOverlay();
            }
            return;
        }

        if (target.classList.contains('delete-row-btn')) {
            if (!id) return;
            const item = patrimonioFullList.find(i => i.id === id);
            
            document.getElementById('delete-item-info-edit').textContent = `Tombo: ${item.Tombamento || 'S/T'} - ${item.Descrição}`;
            document.getElementById('confirm-delete-btn-edit').dataset.idToDelete = id;
            DOM_EDIT_INV.deleteConfirmModal.classList.remove('hidden');
            return;
        }
        
        // INÍCIO DA ALTERAÇÃO: Lógica de salvar-antes-de-sincronizar
        if (target.classList.contains('sync-giap-btn')) {
            if (!id) return;

            // 1. Pega o item original do estado
            let item = patrimonioFullList.find(i => i.id === id);
            if (!item) return;

            // 2. Verifica se o item está "sujo" (tem alterações pendentes)
            if (dirtyItems.has(id)) {
                showOverlay('Salvando alterações pendentes antes de sincronizar...');
                const changes = dirtyItems.get(id);
                
                try {
                    // 3. Salva as alterações pendentes PRIMEIRO
                    const itemRef = doc(db, 'patrimonio', id);
                    await updateDoc(itemRef, { ...changes, updatedAt: serverT() });
                    
                    // 4. Limpa o "sujo" e atualiza o item local
                    dirtyItems.delete(id);
                    document.getElementById(`row-${id}`).classList.remove('is-dirty');
                    DOM_EDIT_INV.saveAllChangesBtn.disabled = dirtyItems.size === 0;

                    // 5. Atualiza o objeto 'item' em memória com as novas alterações
                    item = { ...item, ...changes };
                    
                    // 6. Atualiza o estado global (patrimonioFullList)
                    const globalPatrimonioList = getState().patrimonioFullList;
                    const index = globalPatrimonioList.findIndex(i => i.id === id);
                    if(index > -1) {
                        globalPatrimonioList[index] = item;
                        setState({ patrimonioFullList: globalPatrimonioList }); // Atualiza o estado
                    }
                    
                    await idb.patrimonio.put(item); // Atualiza o cache IDB

                    showNotification('Item salvo! Sincronizando...', 'success');
                    hideOverlay();

                } catch (error) {
                    hideOverlay();
                    console.error("Erro ao salvar item antes de sincronizar:", error);
                    showNotification('Erro ao salvar item. A sincronização foi cancelada.', 'error');
                    return; // Cancela a sincronização se o save falhar
                }
            }

            // 7. Prossiga com a sincronização (agora com o item salvo e atualizado)
            // openSyncModalCallback(item); // <-- REMOVIDO (Não abre mais o modal por padrão)

            // INÍCIO DA NOVA LÓGICA DE SINCRONIZAÇÃO DIRETA
            const { giapMapAllItems } = getState();
            const tombo = normalizeTombo(item.Tombamento);
            const giapItem = tombo ? giapMapAllItems.get(tombo) : null;

            if (!giapItem) {
                // Se não for encontrado, AÍ SIM abre o modal (que mostrará a msg de erro)
                openSyncModalCallback(item);
                return;
            }

            // Se foi encontrado, fazemos a atualização direta sem modal
            showOverlay('Sincronizando dados do GIAP...');

            // NÃO atualizamos a descrição, apenas os metadados
            const changes = {
                Fornecedor: giapItem['Nome Fornecedor'] || '',
                NF: giapItem['NF'] || '',
                Cadastro: giapItem['Cadastro'] || '',
                'Tipo Entrada': giapItem['Tipo Entrada'] || '',
                Unidade_Planilha: giapItem['Unidade'] || '', // Salva a unidade original da planilha
                'Valor NF': giapItem['Valor NF'] || '',
                Espécie: giapItem['Espécie'] || '',
                Status_Planilha: giapItem['Status'] || '', // Salva o status original da planilha
                Observação: `Metadados atualizados do GIAP (via 🔄). | ${item.Observação || ''}`, // Preserva a observação
                updatedAt: serverT()
            };

            try {
                // 1. Salva no Firebase
                const itemRef = doc(db, 'patrimonio', id);
                await updateDoc(itemRef, changes);

                // 2. Atualiza o estado global (patrimonioFullList) e o cache
                const updatedItem = { ...item, ...changes };
                const globalPatrimonioList = getState().patrimonioFullList;
                const index = globalPatrimonioList.findIndex(i => i.id === id);
                if (index > -1) {
                    globalPatrimonioList[index] = updatedItem;
                    setState({ patrimonioFullList: globalPatrimonioList });
                }
                await idb.patrimonio.put(updatedItem);

                // 3. ATUALIZA A UI (os inputs na tabela)
                const row = document.getElementById(`row-${id}`);
                if (row) {
                    // Atualiza os campos que o usuário vê
                    row.querySelector('input[data-field="Fornecedor"]').value = changes.Fornecedor;
                    row.querySelector('input[data-field="NF"]').value = changes.NF;
                    row.querySelector('input[data-field="Observação"]').value = changes.Observação;
                    // Outros campos não estão visíveis na tabela, então não precisam de update de input
                }

                hideOverlay();
                showNotification('Item sincronizado com GIAP!', 'success');

            } catch (e) {
                hideOverlay();
                showNotification('Erro ao sincronizar item.', 'error');
                console.error("Erro na sincronização direta:", e);
            }
            // FIM DA NOVA LÓGICA
        }
        // FIM DA ALTERAÇÃO
    });

    // INÍCIO DA ALTERAÇÃO: Listeners para o novo modal "Adicionar Item"
    DOM_EDIT_INV.addItemToUnitBtn.addEventListener('click', () => {
        if (!currentEditFilter.unidade || !currentEditFilter.tipo) {
            showNotification('Erro: Unidade ou Tipo não definidos.', 'error');
            return;
        }
        
        // Preenche o formulário
        document.getElementById('add-item-unidade').value = currentEditFilter.unidade;
        document.getElementById('add-item-tipo').value = currentEditFilter.tipo;
        document.getElementById('add-item-tombamento').value = 'S/T';
        document.getElementById('add-item-descricao').value = '';
        document.getElementById('add-item-estado').value = 'Bom';
        
        // Abre o modal
        DOM_EDIT_INV.addItemModal.classList.remove('hidden');
        document.getElementById('add-item-descricao').focus();
    });

    const addItemForm = document.getElementById('add-item-form');
    if (addItemForm) {
        addItemForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const newItem = {
                Unidade: document.getElementById('add-item-unidade').value,
                Tipo: document.getElementById('add-item-tipo').value,
                Tombamento: document.getElementById('add-item-tombamento').value.trim() || 'S/T',
                Descrição: document.getElementById('add-item-descricao').value.trim(),
                Estado: document.getElementById('add-item-estado').value,
                // Campos padrão para garantir a consistência do schema
                Localização: '',
                Fornecedor: '',
                NF: '',
                'Origem da Doação': '',
                Quantidade: 1,
                Observação: 'Adicionado manualmente via app.',
                etiquetaPendente: false,
                isPermuta: false,
                createdAt: serverT(),
                updatedAt: serverT()
            };

            if (!newItem.Descrição) {
                showNotification('A Descrição é obrigatória.', 'warning');
                return;
            }

            showOverlay('Adicionando novo item...');
            
            try {
                // 1. Adiciona ao Firestore
                const docRef = await addDoc(collection(db, 'patrimonio'), newItem);
                
                // 2. Adiciona ao cache local (idb)
                newItem.id = docRef.id; // Pega o ID gerado pelo Firestore
                await idb.patrimonio.add(newItem);

                // 3. Fecha o modal e mostra sucesso
                DOM_EDIT_INV.addItemModal.classList.add('hidden');
                addItemForm.reset();
                showNotification('Item adicionado com sucesso! Atualizando...', 'success');
                
                // 4. Recarrega todos os dados
                reloadDataCallback(true); // Força um reload completo

            } catch (error) {
                console.error("Erro ao adicionar item:", error);
                showNotification('Erro ao salvar o item.', 'error');
            } finally {
                hideOverlay();
            }
        });
    }
    // FIM DA ALTERAÇÃO
    
    // Checkbox Mestre (Selecionar Todos)
    DOM_EDIT_INV.selectAllCheckbox.addEventListener('change', (e) => {
        DOM_EDIT_INV.editTableBody.querySelectorAll('.row-checkbox').forEach(cb => {
            cb.checked = e.target.checked;
        });
        updateDeleteButtonState();
    });

    // Botão de Salvar Tudo
    DOM_EDIT_INV.saveAllChangesBtn.addEventListener('click', () => saveAllChanges(reloadDataCallback));
    
    // Botão de Excluir Selecionados
    DOM_EDIT_INV.deleteSelectedBtn.addEventListener('click', () => {
        const { patrimonioFullList } = getState(); // Pega a lista para esta ação
        const checked = DOM_EDIT_INV.editTableBody.querySelectorAll('.row-checkbox:checked');
        if (checked.length === 0) return;
        
        const ids = Array.from(checked).map(cb => cb.dataset.id);
        const firstItem = patrimonioFullList.find(i => i.id === ids[0]);
        
        document.getElementById('delete-modal-title').textContent = `Tem certeza que deseja excluir ${ids.length} item(ns)?`;
        document.getElementById('delete-item-info-edit').textContent = `Excluindo a partir de: ${firstItem.Unidade} (${firstItem.Tipo}).`;
        document.getElementById('confirm-delete-btn-edit').dataset.idsToDelete = JSON.stringify(ids);
        DOM_EDIT_INV.deleteConfirmModal.classList.remove('hidden');
    });

    // Confirmação de Exclusão (Modal)
    document.getElementById('confirm-delete-btn-edit').addEventListener('click', async (e) => {
        const idToDelete = e.target.dataset.idToDelete;
        const idsToDelete = e.target.dataset.idsToDelete;
        
        DOM_EDIT_INV.deleteConfirmModal.classList.add('hidden');
        
        if (idToDelete) {
             await deleteItems([idToDelete]);
        } else if (idsToDelete) {
            await deleteItems(JSON.parse(idsToDelete));
        }
        
        // Após a exclusão, recarrega os dados via orquestrador
        reloadDataCallback(true); // Força um reload completo
    });
    
    // Fechar Modal
    DOM_EDIT_INV.deleteConfirmModal.addEventListener('click', (e) => {
        if (e.target.matches('.js-close-modal-delete') || e.target.matches('.modal-overlay')) {
            DOM_EDIT_INV.deleteConfirmModal.classList.add('hidden');
        }
    });
}
