/**
 * /src/admin/tabTransferencias.js
 * Lógica da aba "Transferências Pendentes" (content-transferencias).
 */

import { db, serverT, writeBatch, doc } from '../services/firebase.js';
import { getState, setState } from '../state/globalStore.js';
import { showNotification, showOverlay, hideOverlay, normalizeStr, escapeHtml } from '../utils/helpers.js';
import { idb } from '../services/cache.js';

const DOM_TRANS = {
    pendingTransfersContainer: document.getElementById('pending-transfers-container'),
};

/**
 * Popula a aba "Transferências Pendentes".
 */
export function populatePendingTransfersTab(reloadDataCallback) {
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
        DOM_TRANS.pendingTransfersContainer.innerHTML = `<p class="text-slate-500 text-center p-4">Nenhuma transferência pendente encontrada.</p>`;
    } else {
        DOM_TRANS.pendingTransfersContainer.innerHTML = tipos.map(tipo => {
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
 * Lida com a ação de transferir ou manter itens na unidade de origem.
 */
async function handleTransferAction(target, reloadDataCallback) {
    const detailsContent = target.closest('details');
    const selectedCheckboxes = detailsContent.querySelectorAll('.transfer-item-checkbox:checked');
    
    if (selectedCheckboxes.length === 0) {
        showNotification('Nenhum item selecionado para a ação.', 'warning');
        return;
    }

    const batch = writeBatch(db);
    let actionDescription = '';
    const { patrimonioFullList } = getState();

    if (target.classList.contains('keep-selected-btn')) {
        actionDescription = `Mantendo ${selectedCheckboxes.length} iten(s) na unidade de origem...`;
        selectedCheckboxes.forEach(cb => {
            const docRef = doc(db, 'patrimonio', cb.dataset.id);
            batch.update(docRef, { 
                Observação: 'Transferência GIAP ignorada manualmente. | ' + (patrimonioFullList.find(i => i.id === cb.dataset.id)?.Observação || ''),
                updatedAt: serverT()
            });
        });
    } else if (target.classList.contains('transfer-selected-btn')) {
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
                Localização: 'Em transferência', // Limpa a localização anterior
                Observação: 'Item transferido para unidade correta via auditoria.',
                updatedAt: serverT()
            });
        });
    }
    
    showOverlay(actionDescription);
    try {
        await batch.commit();
        await idb.metadata.clear(); // Força recarregar
        showNotification('Ação concluída com sucesso! Recarregando dados...', 'success');
        reloadDataCallback();
    } catch (error) {
        hideOverlay();
        showNotification('Ocorreu um erro ao processar a solicitação.', 'error');
        console.error("Erro na ação de transferência:", error);
    }
}


// --- LISTENERS ---

export function setupTransferenciasListeners(reloadDataCallback) {
    DOM_TRANS.pendingTransfersContainer.addEventListener('click', async (e) => {
        const target = e.target;
        
        if (target.classList.contains('select-all-in-unit')) {
            const detailsContent = target.closest('details');
            const checkboxes = detailsContent.querySelectorAll('.transfer-item-checkbox');
            checkboxes.forEach(cb => cb.checked = target.checked);
            return;
        }

        const actionButton = target.closest('.keep-selected-btn, .transfer-selected-btn');
        if (!actionButton) return;

        await handleTransferAction(actionButton, reloadDataCallback);
    });
}
