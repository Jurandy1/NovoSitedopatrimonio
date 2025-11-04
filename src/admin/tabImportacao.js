/**
 * /src/admin/tabImportacao.js
 * Lógica da aba "Importação e Substituição" (content-importacao).
 * * ATUALIZAÇÃO: A funcionalidade principal ("Editar por Descrição") foi simplificada.
 * Removemos a seleção multi-unidade e a substituição total.
 * O fluxo agora é:
 * 1. Usuário seleciona TIPO e UNIDADE de destino.
 * 2. Usuário cola a planilha (que pode ter qualquer nome de unidade, será ignorado).
 * 3. O sistema compara os itens colados com os itens da UNIDADE SELECIONADA.
 * 4. O usuário atualiza item por item na tela de comparação.
 */

// Importa 'updateDoc' e a função de similaridade
import { db, serverT, writeBatch, doc, collection, setDoc, addDoc, getDocs, query, where, deleteDoc, updateDoc } from '../services/firebase.js';
import { getState, setState } from '../state/globalStore.js';
import { showNotification, showOverlay, hideOverlay, normalizeStr, escapeHtml, normalizeTombo, debounce, parseEstadoEOrigem } from '../utils/helpers.js';
import { calculateSimilarity } from '../utils/similarity.js'; // Importa a função de similaridade
import { idb } from '../services/cache.js';

/**
 * Normaliza strings de estado de conservação para os padrões do sistema.
 * @param {string} estadoStr - O estado lido da planilha (ex: "Avariada", "Ruim", "Bom")
 * @returns {string} - O estado padronizado (ex: "Avariado", "Bom")
 */
const normalizeEstadoConservacao = (estadoStr) => {
    // Extrai o estado primário usando a função parseEstadoEOrigem (que já limpa parênteses)
    const { estado } = parseEstadoEOrigem(estadoStr);
    
    const normalized = normalizeStr(estado);
    
    if (['avariado', 'avariada', 'quebrado', 'defeito', 'danificado', 'ruim'].some(k => normalized.includes(k))) return 'Avariado';
    if (normalized.startsWith('novo')) return 'Novo';
    if (normalized.startsWith('bom') || normalized.startsWith('otimo')) return 'Bom';
    if (normalized.startsWith('regular')) return 'Regular';
    
    if (normalized === '') return 'Regular'; // Se estiver vazio, assume Regular
    return 'Regular'; // Padrão
};

/**
 * Extrai informação de doação de colunas da planilha
 * @param {object} item - O objeto da linha (com cabeçalhos normalizados)
 * @returns {string} - O texto da origem da doação, se encontrado.
 */
const extractOrigemDoacao = (item) => {
    // 1. Verifica se a coluna "origem da doacao" existe e tem valor (prioridade)
    const origemColuna = item['origem da doacao'] || '';
    if (origemColuna.trim() && origemColuna.trim() !== '-') {
        return origemColuna.trim();
    }
    
    // 2. Tenta extrair a origem do campo estado de conservação (que pode ter o texto entre parênteses)
    const estadoInput = item['estado de conservacao'] || item.estado || '';
    const { origem } = parseEstadoEOrigem(estadoInput);

    if (origem) {
        return origem;
    }

    // 3. Se não, verifica se "(DOAÇÃO)" está na descrição
    const descInput = item.descricao || item.item || '';
    if (normalizeStr(descInput).includes('(doacao)')) {
        return 'Doação (Via Descrição)';
    }

    return ''; // Nenhum encontrado
};

// Estado local para a importação
let importData = {
    pasted: [], // Todos os itens colados
    selectedUnitName: null, // A unidade de destino selecionada
    fieldUpdates: {}, // Campos a atualizar: { Tombamento: true, ... }
    comparisonData: [], // Dados de comparação item-a-item
    stItemsInManualLinkPool: new Map(), // Pool de itens S/T do sistema disponíveis para ligação manual
};

// Rastreia qual item "Não Encontrado" está sendo ligado
let selPastedItemIndex = null; 

const DOM_IMPORT = {
    // Nav
    subTabNav: document.querySelectorAll('#content-importacao .sub-nav-btn'),

    // Substituir (Oculto, mas IDs podem ser referenciados)
    // replaceTipo: document.getElementById('replace-tipo'),
    // replaceUnit: document.getElementById('replace-unit'),
    
    // Editar por Descrição (Agora "Importar e Atualizar Unidade")
    importTipo: document.getElementById('import-tipo'),
    importUnit: document.getElementById('import-unit'),
    editByDescFields: document.getElementById('edit-by-desc-fields'),
    editByDescData: document.getElementById('edit-by-desc-data'),
    previewEditByDescBtn: document.getElementById('preview-compare-btn'), // ID Alterado no HTML
    
    // Seção de Mapeamento de Unidade (Removida do fluxo)
    // editByDescUnitMatching: document.getElementById('edit-by-desc-unit-matching'),
    // editByDescUnitTableContainer: document.getElementById('edit-by-desc-unit-table-container'),
    // confirmUnitMappingBtn: document.getElementById('confirm-unit-mapping-btn'),
    
    // Resultados da Comparação (Mantido)
    editByDescResults: document.getElementById('edit-by-desc-results'),
    editByDescPreviewTableContainer: document.getElementById('edit-by-desc-preview-table-container'),
    confirmEditByDescBtn: document.getElementById('confirm-edit-by-desc-btn'),
    editByDescSelectAll: document.getElementById('edit-by-desc-select-all'),
    editByDescBulkAction: document.getElementById('edit-by-desc-bulk-action'),
    editByDescBulkApply: document.getElementById('edit-by-desc-bulk-apply'),
    editByDescSummary: document.getElementById('edit-by-desc-summary'),
    editByDescActionFilter: document.getElementById('edit-by-desc-action-filter'),
    
    // Importar em Massa (Mantido)
    massTransferTombos: document.getElementById('mass-transfer-tombos'),
    massTransferTipo: document.getElementById('mass-transfer-tipo'),
    massTransferUnit: document.getElementById('mass-transfer-unit'),
    massTransferSearchBtn: document.getElementById('mass-transfer-search-btn'),
    massTransferResults: document.getElementById('mass-transfer-results'),
    massTransferList: document.getElementById('mass-transfer-list'),
    massTransferConfirmBtn: document.getElementById('mass-transfer-confirm-btn'),
    massTransferSetAllStatus: document.getElementById('mass-transfer-set-all-status'),

    // Adicionar GIAP Customizada (Mantido)
    addGiapNumber: document.getElementById('add-giap-number'),
    addGiapName: document.getElementById('add-giap-name'),
    saveGiapUnitBtn: document.getElementById('save-giap-unit-btn'),

    // IDs do novo Modal de Ligação Manual (Mantido)
    manualLinkModal: document.getElementById('manual-link-modal'),
    manualLinkPastedItem: document.getElementById('manual-link-pasted-item'),
    manualLinkUnitName: document.getElementById('manual-link-unit-name'),
    manualLinkSystemItemSelect: document.getElementById('manual-link-system-item-select'),
    manualLinkUpdateDesc: document.getElementById('manual-link-update-desc'),
    manualLinkConfirmBtn: document.getElementById('manual-link-confirm-btn'),
};

/**
 * Popula os selects de Tipo em todas as sub-abas de Importação/Substituição.
 */
export function populateImportAndReplaceTab() {
    const { patrimonioFullList } = getState();
    
    // Deduplica e popula tipos
    const tiposMap = new Map();
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!tiposMap.has(normalized)) {
            tiposMap.set(normalized, tipo.trim());
        }
    });
    const tipos = [...tiposMap.values()].sort(); 
    
    const selects = [
        DOM_IMPORT.massTransferTipo,
        // DOM_IMPORT.replaceTipo, // Removido do fluxo
        DOM_IMPORT.importTipo // Adicionado
    ];

    selects.forEach(select => {
        if(select) select.innerHTML = '<option value="">Selecione um Tipo</option>' + tipos.map(t => `<option value="${t}">${t}</option>`).join('');
    });
}

/**
 * Lógica para popular dinamicamente os selects de Unidade com base no Tipo.
 * @param {string} tipoSelectId - ID do select de Tipo.
 * @param {string} unitSelectId - ID do select de Unidade.
 */
function setupUnitSelect(tipoSelectEl, unitSelectEl) {
    tipoSelectEl.addEventListener('change', () => {
        const { patrimonioFullList } = getState();
        const selectedTipo = tipoSelectEl.value;
        if (!selectedTipo) {
            unitSelectEl.innerHTML = '<option value="">Selecione uma Unidade</option>'; // Limpa e adiciona a opção padrão
            unitSelectEl.disabled = true;
            return;
        }
        
        const unidadesMap = new Map();
        patrimonioFullList.filter(i => normalizeStr(i.Tipo) === normalizeStr(selectedTipo)).map(i => i.Unidade).filter(Boolean).forEach(unidade => {
            const normalized = normalizeStr(unidade);
            if (!unidadesMap.has(normalized)) {
                unidadesMap.set(normalized, unidade.trim());
            }
        });
        const unidades = [...unidadesMap.values()].sort();
        unitSelectEl.innerHTML = '<option value="">Selecione uma Unidade</option>' + unidades.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
        unitSelectEl.disabled = false;
    });
}

// --- Funções da Lógica "Importar e Atualizar Unidade" ---

/**
 * ETAPA 1 (Simplificada): Processa o mapeamento de unidades e prepara os dados de comparação de itens.
 * Esta função é chamada diretamente pelo botão "Comparar".
 */
function processAndLoadItems() {
    const { patrimonioFullList } = getState();
    
    // 1. Lê a unidade selecionada (fluxo simplificado)
    const selectedSystemUnit = DOM_IMPORT.importUnit.value;
    if (!selectedSystemUnit) {
        showNotification('Nenhuma unidade de destino foi selecionada.', 'warning');
        return;
    }

    // 2. Prepara os dados de comparação e o pool de S/T para ligação manual
    importData.comparisonData = [];
    importData.stItemsInManualLinkPool.clear(); // Limpa o pool de S/T

    // Agrupa os itens do sistema por unidade para performance e prepara o pool S/T
    const systemItemsInUnit = [...patrimonioFullList.filter(i => normalizeStr(i.Unidade) === normalizeStr(selectedSystemUnit))];

    // Preenche o pool S/T para ligação manual para esta unidade (REGRA 3)
    const stItems = systemItemsInUnit.filter(i => {
        const tombo = normalizeTombo(i.Tombamento);
        const isNoTombo = (tombo === 's/t' || tombo === '');
        const isNotPermuta = !i.isPermuta;
        return isNoTombo && isNotPermuta;
    });
    importData.stItemsInManualLinkPool.set(selectedSystemUnit, stItems);
    importData.selectedUnitName = selectedSystemUnit;
    
    // 3. Itera sobre os itens colados e encontra correspondências
    importData.pasted.forEach(pastedItem => {
        
        // --- FILTRO DE ENTRADA RÍGIDO (REGRA DE NEGÓCIO) ---
        const pastedTombo = normalizeTombo(pastedItem.tombamento || pastedItem.tombo || '');

        // 1. Descarta se não é tombo numérico (REGRA DO USUÁRIO)
        if (pastedTombo === 's/t' || pastedTombo === '' || pastedTombo.toLowerCase().includes('permuta') || isNaN(pastedTombo)) {
             return; 
        }

        // Passa a "piscina" de itens para o findBestMatch
        // Usamos a cópia 'systemItemsInUnit' que pode ser modificada
        const { match, score, reason } = findBestMatch(pastedItem, systemItemsInUnit);
        
        // --- FILTRO DE SAÍDA RÍGIDO (REQUISITO) ---
        
        // Se deu match exato (Tombo == Tombo), DESCARTA (REGRA DO USUÁRIO)
        if (reason === 'Tombo Exato - Limpo') {
            return;
        }

        if (match === null && reason.includes('Tombo Não Encontrado no Sistema')) {
             // Caso Sobrando (Vermelho) - Permite passar para ação de criação
             // Se o Tombo da planilha não está no sistema, listamos para CRIAR NOVO
             const comparisonRow = { 
                pastedItem, 
                bestMatch: null, 
                score: 0, 
                systemUnitName: selectedSystemUnit, 
                updateDescription: false,
                initialAction: 'create_new' // Adiciona a ação inicial
            };
            importData.comparisonData.push(comparisonRow);
        } else if (match !== null) {
             // Caso Match Forte (Verde) - Permite passar para ação de atualização
            const matchIndex = systemItemsInUnit.findIndex(item => item.id === match.id);
            if (matchIndex > -1) {
                // Remove o item encontrado para não ser usado em outro match da planilha
                systemItemsInUnit.splice(matchIndex, 1);
            }
            
            const comparisonRow = { 
                pastedItem, 
                bestMatch: match, 
                score, 
                systemUnitName: selectedSystemUnit, 
                updateDescription: false,
                initialAction: 'update' // Adiciona a ação inicial
            };
            importData.comparisonData.push(comparisonRow);
        }
        // Qualquer outro caso (Match fraco, falha no filtro rigoroso) é descartado para "lista limpa".
    });

    // 4. Renderiza a tabela de revisão de itens (Etapa 2)
    renderEditByDescPreview(importData.comparisonData, importData.fieldUpdates);
    
    // Mostra a etapa 2
    DOM_IMPORT.editByDescResults.classList.remove('hidden');
    document.getElementById('edit-by-desc-preview-count').textContent = importData.comparisonData.length;
}


/**
 * Encontra a melhor correspondência para a planilha: Tombo Exato OU Match Rígido (S/T).
 */
function findBestMatch(pastedItem, itemsPool) {
    const pastedDesc = normalizeStr(pastedItem.descricao || pastedItem.item || '');
    const pastedTombo = normalizeTombo(pastedItem.tombamento || pastedItem.tombo || '');
    const pastedLocal = normalizeStr(pastedItem.local || pastedItem.localizacao || '');
    const pastedEstado = normalizeEstadoConservacao(pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular');
    
    // --- 1. Busca Preliminar: Item Tombado (Tombo Exato) ---
    // O filtro de entrada garante que pastedTombo é numérico aqui.
    if (pastedTombo) { 
        const exactTomboMatch = itemsPool.find(item => normalizeTombo(item.Tombamento) === pastedTombo);
        if (exactTomboMatch) {
            // Se o item JÁ TIVER O MESMO TOMBO, DESCARTAR para não poluir a lista. (REGRA DO USUÁRIO)
            if (normalizeStr(exactTomboMatch.Descrição) === normalizeStr(pastedItem.descricao || pastedItem.item || '')) {
                 return { match: exactTomboMatch, score: 1.0, reason: 'Tombo Exato - Limpo' };
            }
            // Se achou pelo Tombo, mas a descrição é diferente, o match é 1.0 (Atualização de metadados/descrição)
            return { match: exactTomboMatch, score: 1.0, reason: 'Tombo Exato' };
        }
    }
    
    // --- NOVO PASSO: BUSCA POR MATCH RÍGIDO em CANDIDATOS S/T ---
    // Isto ocorre APENAS se o Tombo da Planilha NÃO foi encontrado no sistema (que é o caso atual, pois a Busca 1 falhou).

    // Filtro de candidatos: APENAS itens S/T (sem Tombo) para LIGAR
    const stCandidates = itemsPool.filter(item => {
        const tombo = normalizeTombo(item.Tombamento);
        // Garante que é S/T e não é permuta
        return (tombo === 's/t' || tombo === '') && !item.isPermuta;
    });

    // 2. Match: Rígido (Local + Estado + Nome Similar) em CANDIDATOS S/T
    for (const systemItem of stCandidates) {
        const systemDesc = normalizeStr(systemItem.Descrição);
        const systemLocal = normalizeStr(systemItem.Localização);
        const systemEstado = normalizeEstadoConservacao(systemItem.Estado);
        
        // Requisito: Local e Estado devem ser EXATOS (RIGOROSO)
        if (systemLocal !== pastedLocal || systemEstado !== pastedEstado) {
            continue; 
        }

        // Requisito: Nome QUASE IGUAL (similaridade alta > 0.9)
        const nameScore = calculateSimilarity(pastedDesc, systemDesc);
        if (nameScore > 0.9) { 
            // Match encontrado! Este item S/T será atualizado com o Tombo da planilha.
            return { match: systemItem, score: 0.95, reason: 'Match Rigoroso em S/T' }; 
        }
    }
    
    // --- 3. Falha: Sobrando ---
    // Se não achou por Tombo Exato E não achou por Match Rígido em S/T.
    return { match: null, score: 0, reason: 'Tombo Não Encontrado no Sistema' };
}


/**
 * Renderiza a tabela de comparação para "Importar e Atualizar Unidade".
 * @param {Array<object>} comparisonData - Dados processados da comparação.
 * @param {object} fieldUpdates - Objeto {Tombamento: true, ...}
 */
function renderEditByDescPreview(comparisonData, fieldUpdates) {
    const container = DOM_IMPORT.editByDescPreviewTableContainer;
    container.innerHTML = ''; // Limpa o container

    // (Req 1) Agrupa os dados por unidade do sistema (agora será apenas uma)
    const groupedByUnit = comparisonData.reduce((acc, row) => {
        row.finalAction = row.finalAction || (row.bestMatch ? 'update' : 'create_new');
        
        const unitName = row.systemUnitName || 'Unidade Inválida';
        if (!acc[unitName]) {
            acc[unitName] = [];
        }
        acc[unitName].push(row);
        return acc;
    }, {});

    const actionFilter = DOM_IMPORT.editByDescActionFilter.value;
    let html = '';

    // Itera sobre cada unidade agrupada
    Object.entries(groupedByUnit).forEach(([systemUnitName, items]) => {
        
        // Filtra os itens por unidade antes de renderizar
        const filteredItems = items.filter(row => {
            const currentAction = row.bestMatch && row.finalAction === 'create_new' ? 'update' : row.finalAction;

            if (actionFilter === 'all') return true;
            
            if (actionFilter === 'manual') {
                 return currentAction === 'create_new' && row.bestMatch === null;
            }
            
            return currentAction === actionFilter;
        });

        if (filteredItems.length === 0) return; // Se a unidade não tem itens com o filtro, não renderiza

        // Remove a 'details' e 'summary' pois agora é só uma unidade
        html += `
                <div class="p-2 overflow-x-auto">
                    <table class="w-full text-sm min-w-[900px]">
                        <thead class="bg-slate-50">
                            <tr>
                                <th class="p-2 text-left w-10"><input type="checkbox" class="h-4 w-4 edit-by-desc-unit-select-all" title="Selecionar todos nesta unidade"></th>
                                <th class="p-2 text-left">Sua Planilha (Item Colado)</th>
                                <th class="p-2 text-left">Sistema (Item Encontrado)</th>
                                <th class="p-2 text-left w-48">Ação</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        // Itera sobre os itens *dentro* de cada unidade
        filteredItems.forEach((row) => {
            const index = comparisonData.indexOf(row);
            const { pastedItem, bestMatch, score, systemUnitName, finalAction } = row;
            const currentRenderAction = bestMatch ? 'update' : finalAction;

            // --- Dados da Planilha ---
            const pastedDesc = escapeHtml(pastedItem.descricao || pastedItem.item || 'S/D');
            const pastedTombo = escapeHtml(pastedItem.tombamento || pastedItem.tombo || 'S/T');
            const pastedLocal = escapeHtml(pastedItem.local || pastedItem.localizacao || 'N/I');
            const pastedEstadoInput = pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular';
            const { estado: pastedEstado, origem: pastedOrigem } = parseEstadoEOrigem(pastedEstadoInput);
            const pastedObs = escapeHtml(pastedItem.observacao || pastedItem.obs || '');

            // Define quais campos serão atualizados (agora hardcoded para o fluxo desejado)
            const fieldsToUpdate = {
                Descrição: true,
                Tombamento: true,
                Localização: true,
                Estado: true,
                Observação: true,
                Origem: true // Origem da Doação
            };

            const descHtml = fieldsToUpdate.Descrição ? `<span class="text-red-600 font-bold">${pastedDesc} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedDesc} (IGNORAR)</span>`;
            const tomboHtml = fieldsToUpdate.Tombamento ? `<span class="text-red-600 font-bold">${pastedTombo} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedTombo} (IGNORAR)</span>`;
            const localHtml = fieldsToUpdate.Localização ? `<span class="text-red-600 font-bold">${pastedLocal} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedLocal} (IGNORAR)</span>`;
            const estadoHtml = fieldsToUpdate.Estado ? `<span class="text-red-600 font-bold">${pastedEstado} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedEstado} (IGNORAR)</span>`;
            const obsHtml = fieldsToUpdate.Observação ? `<span class="text-red-600 font-bold">${pastedObs || '...'} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedObs || '...'} (IGNORAR)</span>`;
            const origemHtml = fieldsToUpdate.Origem ? `<p><strong>Origem (Auto):</strong> <span class="text-red-600 font-bold">${escapeHtml(pastedOrigem || 'N/D')} (ATUALIZAR)</span></p>` : `<p><strong>Origem (Auto):</strong> <span class="text-slate-500">${escapeHtml(pastedOrigem || 'N/D')} (IGNORAR)</span></p>`;


            let planilhaHtml = `
                <p class="font-semibold">${descHtml}</p>
                <p><strong>Tombo:</strong> ${tomboHtml}</p>
                <p><strong>Local:</strong> ${localHtml}</p>
                <p><strong>Estado:</strong> ${estadoHtml}</p>
                ${origemHtml}
                <p><strong>Obs:</strong> ${obsHtml}</p>
                <p class="text-xs text-blue-600 mt-1">Planilha: ${escapeHtml(pastedItem.unidade)}</p>
            `;

            let rowClass = '';
            let systemHtml = '';
            let actionHtml = '';
            
            const pastedTomboNormalizado = normalizeTombo(pastedItem.tombamento || pastedItem.tombo);


            if (bestMatch) {
                // Correspondência Forte (Verde - Score 1.0 ou 0.95)
                rowClass = 'bg-green-50';
                
                const matchReason = score >= 1.0 ? 'Tombo Exato' : 'Match Rigoroso (S/T)';
                const systemOrigem = bestMatch['Origem da Doação'] || 'N/D';
                
                systemHtml = `
                    <p class="font-semibold text-green-800">${escapeHtml(bestMatch.Descrição)}</p>
                    <p><strong>Tombo Atual:</strong> ${escapeHtml(bestMatch.Tombamento)}</p>
                    <p><strong>Local Atual:</strong> ${escapeHtml(bestMatch.Localização)}</p>
                    <p><strong>Estado Atual:</strong> ${escapeHtml(bestMatch.Estado)}</p>
                    <p><strong>Origem Atual:</strong> <span class="text-slate-700 font-medium">${escapeHtml(systemOrigem)}</span></p>
                    <p class="text-xs text-slate-500 mt-1">ID: ${bestMatch.id} | Motivo: ${matchReason}</p>
                `;
                actionHtml = `
                    <select class="edit-by-desc-action w-full p-2 border rounded-lg bg-white" data-system-id="${bestMatch.id}" data-row-index="${index}">
                        <option value="update" ${currentRenderAction === 'update' ? 'selected' : ''}>Atualizar Campos</option>
                        <option value="ignore" ${currentRenderAction === 'ignore' ? 'selected' : ''}>Ignorar</option>
                    </select>
                `;
            } else {
                // Não Encontrado (Vermelho) - Item Sobrando (Tombo não existe no sistema)
                rowClass = 'bg-red-50';
                
                systemHtml = `<p class="font-semibold text-red-700">Tombo ${pastedTomboNormalizado} não encontrado no sistema.</p>`;
                
                actionHtml = `
                    <div class="space-y-1">
                        <select class="edit-by-desc-action w-full p-2 border rounded-lg bg-white" data-system-id="new-item-${index}" data-row-index="${index}">
                            <option value="create_new" ${currentRenderAction === 'create_new' ? 'selected' : ''}>Criar Novo Item (Sobrando)</option>
                            <option value="ignore" ${currentRenderAction === 'ignore' ? 'selected' : ''}>Ignorar Linha</option>
                        </select>
                        <button type="button" class="link-manual-btn w-full bg-yellow-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-yellow-600">Ligar S/T Manualmente</button>
                    </div>
                `;
            }

            html += `
                <tr class="border-b ${rowClass}" data-row-index="${index}" data-action="${currentRenderAction}">
                    <td class="p-2 align-top"><input type="checkbox" class="edit-by-desc-row-checkbox h-4 w-4" ${currentRenderAction !== 'ignore' ? 'checked' : ''}></td>
                    <td class="p-2 align-top">${planilhaHtml}</td>
                    <td class="p-2 align-top">${systemHtml}</td>
                    <td class="p-2 align-top">${actionHtml}</td>
                </tr>
            `;
        });

        html += `</tbody></table></div>`;
    });

    container.innerHTML = html;

    // Atualiza o sumário
    updateEditByDescSummary();
    // Re-adiciona listener para o filtro de ação
    DOM_IMPORT.editByDescActionFilter.addEventListener('change', debounce(() => renderEditByDescPreview(comparisonData, fieldUpdates), 50));
}

/**
 * Atualiza o sumário de ações com base nas seleções atuais.
 */
function updateEditByDescSummary() {
    let uiUpdateCount = 0;
    let uiCreateCount = 0;
    let uiIgnoreCount = 0;
    let uiManualCount = 0;
    
    DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('tr[data-row-index]').forEach(rowEl => {
        const select = rowEl.querySelector('select.edit-by-desc-action');
        const action = select ? select.value : null;
        const rowIndex = parseInt(rowEl.dataset.rowIndex, 10);
        
        const rowData = importData.comparisonData[rowIndex];
        
        const isManual = (action === 'create_new' && rowData && rowData.bestMatch === null); 

        if (action === 'update') uiUpdateCount++;
        else if (action === 'ignore') uiIgnoreCount++;
        else if (action === 'create_new') {
            if (isManual) uiManualCount++;
            else uiCreateCount++;
        }
    });
    
    DOM_IMPORT.editByDescSummary.textContent = 
        `${uiUpdateCount} para ATUALIZAR, ${uiCreateCount} para CRIAR, ${uiIgnoreCount} para IGNORAR, ${uiManualCount} MANUAIS.`;
    
    DOM_IMPORT.confirmEditByDescBtn.disabled = (uiUpdateCount + uiCreateCount + uiManualCount) === 0;
}

/**
 * Abre o modal para ligar manualmente um item "Não Encontrado".
 * @param {number} rowIndex - O índice do item em `importData.comparisonData`.
 */
function openManualLinkModal(rowIndex) {
    selPastedItemIndex = rowIndex; // Armazena o índice
    const { pastedItem, systemUnitName } = importData.comparisonData[rowIndex];

    const pastedLocalInput = pastedItem.local || pastedItem.localizacao || '';
    const pastedLocal = normalizeStr(pastedLocalInput);
    const pastedLocalDisplay = escapeHtml(pastedLocalInput || 'N/A');
    const pastedEstado = normalizeEstadoConservacao(pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular');
    const pastedTomboDisplay = escapeHtml(pastedItem.tombamento || pastedItem.tombo);


    // 1. Preenche os detalhes do item colado (ADICIONANDO O LOCAL DE DESTAQUE E ESTADO/ORIGEM)
    const { origem: pastedOrigem } = parseEstadoEOrigem(pastedItem['estado de conservacao'] || pastedItem.estado || '');

    DOM_IMPORT.manualLinkPastedItem.innerHTML = `
        <p><strong>Descrição:</strong> ${escapeHtml(pastedItem.descricao || pastedItem.item)}</p>
        <p><strong>Tombo (Planilha):</strong> <span class="font-bold text-lg text-red-600">${pastedTomboDisplay}</span></p>
        <p><strong>Estado (Planilha):</strong> <span class="font-bold text-blue-600">${escapeHtml(pastedEstado)}</span> | 
        <strong>Origem (Planilha):</strong> <span class="font-bold text-blue-600">${escapeHtml(pastedOrigem || 'N/D')}</span></p>
        <p><strong>Local (Planilha):</strong> <span class="font-bold text-lg text-blue-600">${pastedLocalDisplay}</span></p>
    `;

    // 2. Preenche o nome da unidade
    DOM_IMPORT.manualLinkUnitName.textContent = systemUnitName;

    // --- LÓGICA DE FILTRAGEM RÍGIDA E PONTUAÇÃO (REGRA DO USUÁRIO) ---
    
    // Pool completo de S/T para a unidade (já exclui itens com tombo e permuta)
    const allStCandidatesPool = importData.stItemsInManualLinkPool.get(systemUnitName) || [];
    
    let systemItems = allStCandidatesPool;
    let locationMatch = false;

    // 1. Aplica Filtro de Localização Rígida (Se a planilha tiver Local, só mostra itens desse Local)
    if (pastedLocal && pastedLocal !== 'n/a' && pastedLocal !== 'n/i') {
        const filteredByLocation = allStCandidatesPool.filter(item => 
            normalizeStr(item.Localização) === pastedLocal
        );
        systemItems = filteredByLocation;
        locationMatch = filteredByLocation.length > 0;
    } 

    // 2. Aplica Filtro de Similaridade e Ordenação 
    const pastedDesc = normalizeStr(pastedItem.descricao || pastedItem.item || '');

    const candidatesWithScore = systemItems.map(item => {
        const systemDesc = normalizeStr(item.Descrição);
        const score = calculateSimilarity(pastedDesc, systemDesc);
        
        if (score < 0.3) return null; 

        return {
            item,
            score
        };
    }).filter(c => c !== null); // Remove os itens com score muito baixo

    // 4. Ordena por score (mais similar primeiro)
    candidatesWithScore.sort((a, b) => b.score - a.score);


    // 5. Preenche o select
    DOM_IMPORT.manualLinkSystemItemSelect.innerHTML = '<option value="">-- Selecione um item --</option>' +
        candidatesWithScore.map(({ item, score }) => {
            const systemOrigem = item['Origem da Doação'] || 'N/D';
            const itemOrigem = systemOrigem.length > 20 ? systemOrigem.substring(0, 17) + '...' : systemOrigem;
            
            const systemEstado = normalizeEstadoConservacao(item.Estado || 'Regular');
            
            return `
                <option value="${item.id}" data-score="${score.toFixed(2)}">
                    [Score: ${score.toFixed(2)}] ${escapeHtml(item.Descrição)} 
                    (Local: ${escapeHtml(item.Localização || 'N/I')} | 
                    Estado: ${escapeHtml(item.Estado || 'N/D')} | 
                    Origem: ${escapeHtml(itemOrigem)})
                </option>
            `;
        }).join('');

    // 6. Exibe a mensagem de feedback
    const filterMessage = document.getElementById('manual-link-filter-message');
    if (filterMessage) {
        if (pastedLocal && locationMatch) {
             filterMessage.innerHTML = `<span class="font-semibold text-green-700">${systemItems.length} itens</span> filtrados estritamente pela Localização correspondente (${pastedLocalDisplay}).`;
        } else if (pastedLocal && !locationMatch) {
             filterMessage.innerHTML = `<span class="font-semibold text-red-700">Nenhum item S/T encontrado no local ${pastedLocalDisplay}.</span> A lista está vazia (Filtro Rígido).`;
        } else {
             filterMessage.innerHTML = `Localização da planilha não especificada. Listando todos os ${candidatesWithScore.length} itens S/T com similaridade de nome (> 0.3).`;
        }
    }

    // 7. Reseta o checkbox e abre o modal
    DOM_IMPORT.manualLinkUpdateDesc.checked = false;
    DOM_IMPORT.manualLinkModal.classList.remove('hidden');
}

/**
 * Confirma a ligação manual feita no modal.
 */
function confirmManualLink() {
    if (selPastedItemIndex === null) return;

    const systemId = DOM_IMPORT.manualLinkSystemItemSelect.value;
    const isUpdateDescChecked = DOM_IMPORT.manualLinkUpdateDesc.checked;

    if (!systemId) {
        return showNotification('Você precisa selecionar um item do sistema para ligar.', 'warning');
    }

    const { patrimonioFullList } = getState();
    const systemItem = patrimonioFullList.find(i => i.id === systemId);
    if (!systemItem) {
        return showNotification('Erro: Item do sistema não encontrado.', 'error');
    }

    // Retirada do pool para evitar reuso (REGRA 1)
    const unitName = systemItem.Unidade;
    const pool = importData.stItemsInManualLinkPool.get(unitName);
    if (pool) {
        const index = pool.findIndex(item => item.id === systemId);
        if (index > -1) {
            pool.splice(index, 1);
        }
    }

    // Atualiza a linha de comparação em memória
    const comparisonRow = importData.comparisonData[selPastedItemIndex];
    comparisonRow.bestMatch = systemItem;
    comparisonRow.score = 1.0; // 1.0 para indicar override manual
    comparisonRow.updateDescription = isUpdateDescChecked; // Armazena a escolha
    comparisonRow.finalAction = 'update';

    // Fecha o modal
    DOM_IMPORT.manualLinkModal.classList.add('hidden');
    selPastedItemIndex = null;

    DOM_IMPORT.editByDescActionFilter.value = 'all'; 
    renderEditByDescPreview(importData.comparisonData, importData.fieldUpdates);
    showNotification('Item ligado manualmente. A linha foi movida para "Atualizar".', 'success');
}

/**
 * Lida com o fechamento/cancelamento do modal de ligação manual.
 */
function handleManualLinkModalClose() {
    selPastedItemIndex = null;
    DOM_IMPORT.manualLinkModal.classList.add('hidden');
}


// --- LISTENERS ---

export function setupImportacaoListeners(reloadDataCallback) {
    // 1. Setup para selects de unidade
    setupUnitSelect(DOM_IMPORT.massTransferTipo, DOM_IMPORT.massTransferUnit);
    // setupUnitSelect(DOM_IMPORT.replaceTipo, DOM_IMPORT.replaceUnit); // Removido
    setupUnitSelect(DOM_IMPORT.importTipo, DOM_IMPORT.importUnit); // Adicionado

    // 2. Lógica de Importação em Massa (Mantida)
    DOM_IMPORT.massTransferSearchBtn.addEventListener('click', async () => {
        const { patrimonioFullList, giapMap } = getState();
        const tombos = DOM_IMPORT.massTransferTombos.value.split(/[,;\s\n]+/).map(t => normalizeTombo(t)).filter(t => t && t.toLowerCase() !== 's/t');
        const tipo = DOM_IMPORT.massTransferTipo.value;
        const unidade = DOM_IMPORT.massTransferUnit.value;
        
        if (tombos.length === 0 || !tipo || !unidade) {
            showNotification('Preencha os tombamentos, tipo e unidade.', 'warning');
            return;
        }
        
        const existingTombos = new Set(patrimonioFullList.map(i => normalizeTombo(i.Tombamento)));
        const itemsToCreate = [];

        tombos.forEach(tombo => {
            if (existingTombos.has(tombo)) {
                return showNotification(`Tombo ${tombo} já existe no inventário.`, 'warning');
            }
            const giapItem = giapMap.get(tombo);
            if (giapItem) {
                itemsToCreate.push({ tombo, giapItem });
            } else {
                 showNotification(`Tombo ${tombo} não encontrado na planilha GIAP.`, 'warning');
            }
        });
        
        DOM_IMPORT.massTransferResults.classList.remove('hidden');
        DOM_IMPORT.massTransferList.innerHTML = itemsToCreate.map(({ tombo, giapItem }) => `
            <div class="p-3 border rounded-md bg-slate-50 flex justify-between items-center">
                <div>
                    <p class="font-bold">${escapeHtml(giapItem.Descrição || giapItem.Espécie)}</p>
                    <p class="text-sm text-slate-500">Tombo: <span class="font-mono">${escapeHtml(tombo)}</span></p>
                </div>
                <div>
                    <select class="p-2 border rounded-lg bg-white status-select" data-tombo="${tombo}">
                         <option>Novo</option><option selected>Bom</option><option>Regular</option><option>Avariado</option>
                    </select>
                </div>
            </div>
        `).join('');
        
        DOM_IMPORT.massTransferConfirmBtn.disabled = itemsToCreate.length === 0;
    });
    
    DOM_IMPORT.massTransferSetAllStatus.addEventListener('change', (e) => {
        const status = e.target.value;
        document.querySelectorAll('#mass-transfer-list .status-select').forEach(select => {
            select.value = status;
        });
    });

    DOM_IMPORT.massTransferConfirmBtn.addEventListener('click', async () => {
        const { giapMap } = getState();
        const tipo = DOM_IMPORT.massTransferTipo.value;
        const unidade = DOM_IMPORT.massTransferUnit.value;
        
        const itemsToSave = [];
        document.querySelectorAll('#mass-transfer-list .status-select').forEach(select => {
            const tombo = select.dataset.tombo;
            const status = select.value;
            const giapItem = giapMap.get(tombo);
            
            if (giapItem) {
                itemsToSave.push({ tombo, status, giapItem });
            }
        });

        if (itemsToSave.length === 0) return;
        
        showOverlay(`Criando ${itemsToSave.length} novos itens...`);
        const batch = writeBatch(db);
        const newItemsForCache = [];

        itemsToSave.forEach(({ tombo, status, giapItem }) => {
            const newItemRef = doc(collection(db, 'patrimonio'));
            const newItem = {
                id: newItemRef.id, Tombamento: tombo, Descrição: giapItem.Descrição || giapItem.Espécie || '',
                Tipo: tipo, Unidade: unidade, Localização: '',
                Fornecedor: giapItem['Nome Fornecedor'] || '', NF: giapItem.NF || '', 'Origem da Doação': '',
                Estado: status, Quantidade: 1, Observação: `Importado em massa do GIAP.`,
                isPermuta: false,
                createdAt: serverT(), updatedAt: serverT()
            };
            batch.set(newItemRef, newItem);
            newItemsForCache.push(newItem);
        });

        try {
            await batch.commit();
            await idb.patrimonio.bulkAdd(newItemsForCache);
            showNotification(`${itemsToSave.length} itens criados com sucesso!`, 'success');
            reloadDataCallback(); 
        } catch (e) {
            hideOverlay();
            showNotification('Erro ao criar itens em massa.', 'error');
            console.error(e);
        }
    });

    // 3. Lógica para Adicionar Nova Unidade GIAP (Mantida)
    DOM_IMPORT.saveGiapUnitBtn.addEventListener('click', async () => {
        const name = DOM_IMPORT.addGiapName.value.trim();
        const number = DOM_IMPORT.addGiapNumber.value.trim();
        
        if (!name) {
            showNotification('O nome da unidade é obrigatório.', 'warning');
            return;
        }

        const { customGiapUnits } = getState();
        const newUnit = { name: name, number: number };
        const newCustomGiapUnits = [...customGiapUnits, newUnit];

        showOverlay('Salvando nova unidade GIAP...');
        try {
            await setDoc(doc(db, 'config', 'customGiapUnits'), { units: newCustomGiapUnits });
            setState({ customGiapUnits: newCustomGiapUnits });
            showNotification(`Unidade "${name}" adicionada!`, 'success');
            
            DOM_IMPORT.addGiapName.value = '';
            DOM_IMPORT.addGiapNumber.value = '';
        } catch (error) {
            showNotification('Erro ao salvar unidade GIAP customizada.', 'error');
            console.error(error);
        } finally {
            hideOverlay();
        }
    });

    // 4. Lógica de Substituir Inventário (Removida)
    // Os listeners para 'previewReplaceBtn' e 'confirmReplaceBtn' foram removidos
    // pois a sub-aba foi ocultada no HTML.

    // 5. Lógica de "Importar e Atualizar Unidade" (Antiga "Editar por Descrição")
    
    // ETAPA 1: Clique em "Comparar Planilha com Unidade"
    DOM_IMPORT.previewEditByDescBtn.addEventListener('click', () => {
        // Reseta o estado local
        importData = { pasted: [], selectedUnitName: null, fieldUpdates: {}, comparisonData: [], stItemsInManualLinkPool: new Map() };

        const data = DOM_IMPORT.editByDescData.value;
        const selectedSystemUnit = DOM_IMPORT.importUnit.value;
        
        if (!selectedSystemUnit) {
             return showNotification('Selecione o Tipo e a Unidade de destino primeiro.', 'warning');
        }
        if (!data) {
             return showNotification('Cole os dados do Excel primeiro.', 'warning');
        }
        
        // Hardcode os campos a atualizar, conforme o novo fluxo
        importData.fieldUpdates = {
            Tombamento: true,
            Descrição: true,
            Localização: true,
            Estado: true,
            Observação: true,
            Origem: true // (Origem da Doação)
        };
        
        const parsed = Papa.parse(data, { 
            header: true, 
            skipEmptyLines: true, 
            delimiter: '\t', 
            transformHeader: h => normalizeStr(h)
        }).data;
        
        if (parsed.length === 0) return showNotification('Nenhum dado válido encontrado (verifique se o cabeçalho foi colado).', 'error');

        // Força a unidade de destino em todos os itens colados
        importData.pasted = parsed.map(item => ({ ...item, unidade: selectedSystemUnit }));
        
        // Esconde o botão de pré-visualização e o formulário
        // DOM_IMPORT.previewEditByDescBtn.classList.add('hidden');
        // DOM_IMPORT.editByDescData.disabled = true;

        // Processa e renderiza a tabela de comparação
        processAndLoadItems();
    });
    
    // Listeners para Ações em Massa (Mantidos)
    if (DOM_IMPORT.editByDescSelectAll) {
        DOM_IMPORT.editByDescSelectAll.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('tr:not([style*="none"]) .edit-by-desc-row-checkbox').forEach(cb => {
                 cb.checked = isChecked;
            });
        });
    }

    if (DOM_IMPORT.editByDescBulkApply) {
        DOM_IMPORT.editByDescBulkApply.addEventListener('click', () => {
            const action = DOM_IMPORT.editByDescBulkAction.value;
            if (!action) return showNotification('Selecione uma ação em massa.', 'warning');

            const checkedRows = DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('tr:not([style*="none"]) .edit-by-desc-row-checkbox:checked');
            if (checkedRows.length === 0) return showNotification('Nenhum item selecionado.', 'warning');

            checkedRows.forEach(cb => {
                const row = cb.closest('tr');
                const select = row.querySelector('.edit-by-desc-action');
                if (select) {
                    select.value = action;
                    
                    const rowIndex = parseInt(row.dataset.rowIndex, 10);
                    if (rowIndex > -1 && importData.comparisonData[rowIndex]) {
                         importData.comparisonData[rowIndex].finalAction = action;
                         row.dataset.action = action; 
                    }
                    
                    cb.checked = (action !== 'ignore');
                }
            });
            updateEditByDescSummary(); 
            showNotification(`Ação em massa aplicada a ${checkedRows.length} itens.`, 'info');
        });
    }

    // Listener para mudança individual de ação (Mantido)
    DOM_IMPORT.editByDescPreviewTableContainer.addEventListener('change', (e) => {
        if (e.target.classList.contains('edit-by-desc-unit-select-all')) {
            const isChecked = e.target.checked;
            const tableBody = e.target.closest('table').querySelector('tbody');
            tableBody.querySelectorAll('tr:not([style*="none"]) .edit-by-desc-row-checkbox').forEach(cb => {
                cb.checked = isChecked;
            });
        }
        
        if (e.target.classList.contains('edit-by-desc-action')) {
            const select = e.target;
            const action = select.value;
            const rowEl = select.closest('tr');
            const rowIndex = parseInt(rowEl.dataset.rowIndex, 10);
            const rowCheckbox = rowEl.querySelector('.edit-by-desc-row-checkbox');

            if (rowIndex > -1 && importData.comparisonData[rowIndex]) {
                 importData.comparisonData[rowIndex].finalAction = action;
                 rowEl.dataset.action = action; 
            }

            rowCheckbox.checked = (action !== 'ignore');
            updateEditByDescSummary();
        }
    });
    
    // Listener para o filtro de ação (Mantido)
    if (DOM_IMPORT.editByDescActionFilter) {
        DOM_IMPORT.editByDescActionFilter.addEventListener('change', () => {
             if (importData.comparisonData.length > 0) {
                 renderEditByDescPreview(importData.comparisonData, importData.fieldUpdates);
             }
        });
    }

    // Listener para o botão "Ligar Manualmente" (Mantido)
    DOM_IMPORT.editByDescPreviewTableContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('link-manual-btn')) {
            const rowIndex = parseInt(e.target.closest('tr').dataset.rowIndex, 10);
            openManualLinkModal(rowIndex);
        }
    });

    // Listeners para o modal de ligação manual (Mantido)
    if (DOM_IMPORT.manualLinkConfirmBtn) {
        DOM_IMPORT.manualLinkConfirmBtn.addEventListener('click', confirmManualLink);
    }
    document.body.addEventListener('click', (e) => {
        if (e.target.matches('.js-close-modal-manual-link') || e.target.matches('#manual-link-modal .modal-overlay')) {
            handleManualLinkModalClose();
        }
    });

    // ETAPA 2: Clique em "Confirmar e Atualizar Itens" (Mantido, mas lógica de campos atualizada)
    DOM_IMPORT.confirmEditByDescBtn.addEventListener('click', async () => {
        const actionSelects = DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('select.edit-by-desc-action');
        const itemsToUpdate = [];
        const itemsToCreate = [];
        const { fieldUpdates, comparisonData } = importData;
        let updateCount = 0; 

        actionSelects.forEach(select => {
            const row = select.closest('tr');
            const rowCheckbox = row.querySelector('.edit-by-desc-row-checkbox');
            const action = select.value;
            const rowIndex = parseInt(row.dataset.rowIndex, 10);
            
            if (action === 'ignore' || !rowCheckbox || !rowCheckbox.checked) {
                return; 
            }

            const systemId = select.dataset.systemId;
            const { pastedItem, bestMatch, updateDescription } = comparisonData[rowIndex];
            const systemUnitName = importData.selectedUnitName; // Pega a unidade selecionada

            if (action === 'create_new') {
                updateCount++;
                const docRef = doc(collection(db, 'patrimonio'));
                
                const pastedTombo = normalizeTombo(pastedItem.tombamento || pastedItem.tombo);
                const estadoInput = pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular';
                const estadoNormalizado = normalizeEstadoConservacao(estadoInput);
                const origemDoacao = extractOrigemDoacao(pastedItem);
                
                const existingItemInUnit = getState().patrimonioFullList.find(i => 
                    normalizeStr(i.Unidade) === normalizeStr(systemUnitName)
                );
                let itemType = existingItemInUnit?.Tipo || 'N/A (AUDITORIA)'; 

                const newItem = {
                    id: docRef.id,
                    Tombamento: pastedTombo, 
                    Descrição: pastedItem.descricao || pastedItem.item || 'Item sem descrição',
                    Tipo: itemType,
                    Unidade: systemUnitName, 
                    Localização: pastedItem.local || pastedItem.localizacao || '',
                    Fornecedor: '', 
                    NF: '', 
                    'Origem da Doação': origemDoacao,
                    Estado: estadoNormalizado,
                    Quantidade: 1, 
                    Observação: `[Criado via Importação - Sobrando]. Tombo: ${pastedTombo}.`,
                    isPermuta: false,
                    createdAt: serverT(), 
                    updatedAt: serverT()
                };
                itemsToCreate.push({ docRef, data: newItem });
                
            } else if (action === 'update') {
                if (systemId && pastedItem && bestMatch) {
                    updateCount++;
                    const changes = { updatedAt: serverT() };
                    let obs = bestMatch.Observação || '';
                    
                    // Lógica de atualização simplificada: atualiza tudo
                    changes.Tombamento = pastedItem.tombamento || pastedItem.tombo;
                    changes.Localização = pastedItem.local || pastedItem.localizacao || '';
                    changes.Estado = normalizeEstadoConservacao(pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular');
                    changes['Origem da Doação'] = extractOrigemDoacao(pastedItem);
                    changes.Observação = pastedItem.observacao || pastedItem.obs || '';
                    
                    // Se foi ligado manualmente E o usuário marcou a caixa, atualiza a descrição
                    if (updateDescription) {
                        changes.Descrição = pastedItem.descricao || pastedItem.item || 'S/D';
                    }
                    
                    const auditMsg = bestMatch.Tombamento !== changes.Tombamento ? '[Tombo Corrigido e Atualizado]' : '[Atualizado via Importação]';
                    changes.Observação = `${auditMsg} ` + (changes.Observação || obs);

                    itemsToUpdate.push({
                        id: systemId,
                        changes: changes
                    });
                }
            }
        });

        if (updateCount === 0) {
            return showNotification('Nenhum item foi marcado (checkbox) para "Atualizar" ou "Criar Novo Item".', 'info');
        }

        showOverlay(`Processando ${itemsToUpdate.length} atualizações e ${itemsToCreate.length} criações...`);
        const batch = writeBatch(db);
        const newItemsForCache = [];
        
        itemsToUpdate.forEach(item => {
            const docRef = doc(db, 'patrimonio', item.id);
            batch.update(docRef, item.changes);
        });

        itemsToCreate.forEach(item => {
            batch.set(item.docRef, item.data);
            newItemsForCache.push(item.data);
        });

        try {
            await batch.commit();
            
            if (newItemsForCache.length > 0) {
                await idb.patrimonio.bulkAdd(newItemsForCache);
            }
            
            await idb.metadata.clear(); 
            
            showNotification(`${updateCount} ações concluídas! Recarregando...`, 'success');
            
            // Reseta a UI da aba
            DOM_IMPORT.editByDescResults.classList.add('hidden');
            DOM_IMPORT.editByDescData.value = '';
            importData = { pasted: [], selectedUnitName: null, fieldUpdates: {}, comparisonData: [], stItemsInManualLinkPool: new Map() };
            
            // Força o recarregamento do estado global
            reloadDataCallback(true); 
            
        } catch (error) {
            hideOverlay();
            showNotification('Erro ao salvar as atualizações/criações.', 'error');
            console.error('Erro ao atualizar itens:', error);
        }
    });
}
