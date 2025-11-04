/**
 * /src/admin/tabImportacao.js
 * Lógica da aba "Importação e Substituição" (content-importacao).
 * * Lógica principal atualizada: Focar em ligar TOMBO da planilha com S/T do sistema 
 * através de Match RÍGIDO (Local + Estado + Nome Similar). 
 * Qualquer falha resulta em "Criar Novo Item".
 */

// INÍCIO DA ALTERAÇÃO: Importa 'updateDoc' e a função de similaridade
import { db, serverT, writeBatch, doc, collection, setDoc, addDoc, getDocs, query, where, deleteDoc, updateDoc } from '../services/firebase.js';
import { getState, setState } from '../state/globalStore.js';
// INÍCIO DA ALTERAÇÃO: Adiciona 'debounce'
import { showNotification, showOverlay, hideOverlay, normalizeStr, escapeHtml, normalizeTombo, debounce, parseEstadoEOrigem } from '../utils/helpers.js';
import { calculateSimilarity } from '../utils/similarity.js'; // Importa a função de similaridade
import { idb } from '../services/cache.js';
// FIM DA ALTERAÇÃO

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
 * INÍCIO: Adiciona função para extrair origem da doação
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
// FIM: Adiciona função

// INÍCIO DA ALTERAÇÃO: Estado local para a importação multi-unidade
let multiUnitImportData = {
    pasted: [], // Todos os itens colados
    unitMap: new Map(), // Mapeamento: "Unidade Colada" -> "Unidade Sistema"
    fieldUpdates: {}, // Campos a atualizar: { Tombamento: true, ... }
    comparisonData: [], // Dados de comparação item-a-item
    stItemsInManualLinkPool: new Map(), // Pool de itens S/T do sistema disponíveis para ligação manual
};
// INÍCIO DA ALTERAÇÃO: Adiciona estado para o modal de ligação manual
let selPastedItemIndex = null; // Rastreia qual item "Não Encontrado" está sendo ligado
// FIM DA ALTERAÇÃO

const DOM_IMPORT = {
    // Nav
    subTabNav: document.querySelectorAll('#content-importacao .sub-nav-btn'),

    // Substituir
    replaceTipo: document.getElementById('replace-tipo'),
    replaceUnit: document.getElementById('replace-unit'),
    replaceData: document.getElementById('replace-data'),
    previewReplaceBtn: document.getElementById('preview-replace-btn'),
    replaceResults: document.getElementById('replace-results'),
    replacePreviewList: document.getElementById('replace-preview-list'),
    replaceConfirmCheckbox: document.getElementById('replace-confirm-checkbox'),
    confirmReplaceBtn: document.getElementById('confirm-replace-btn'),
    
    // Editar por Descrição
    // INÍCIO DA ALTERAÇÃO: Remove selects de tipo/unidade, adiciona container de campos
    editByDescFields: document.getElementById('edit-by-desc-fields'),
    // FIM DA ALTERAÇÃO
    editByDescData: document.getElementById('edit-by-desc-data'),
    previewEditByDescBtn: document.getElementById('preview-edit-by-desc-btn'),
    // INÍCIO DA ALTERAÇÃO: Adiciona novos containers de UI
    editByDescUnitMatching: document.getElementById('edit-by-desc-unit-matching'),
    editByDescUnitTableContainer: document.getElementById('edit-by-desc-unit-table-container'),
    confirmUnitMappingBtn: document.getElementById('confirm-unit-mapping-btn'),
    // FIM DA ALTERAÇÃO
    editByDescResults: document.getElementById('edit-by-desc-results'),
    editByDescPreviewTableContainer: document.getElementById('edit-by-desc-preview-table-container'),
    confirmEditByDescBtn: document.getElementById('confirm-edit-by-desc-btn'),
    editByDescSelectAll: document.getElementById('edit-by-desc-select-all'),
    editByDescBulkAction: document.getElementById('edit-by-desc-bulk-action'),
    editByDescBulkApply: document.getElementById('edit-by-desc-bulk-apply'),
    editByDescSummary: document.getElementById('edit-by-desc-summary'),
    
    // Importar em Massa
    massTransferTombos: document.getElementById('mass-transfer-tombos'),
    massTransferTipo: document.getElementById('mass-transfer-tipo'),
    massTransferUnit: document.getElementById('mass-transfer-unit'),
    massTransferSearchBtn: document.getElementById('mass-transfer-search-btn'),
    massTransferResults: document.getElementById('mass-transfer-results'),
    massTransferList: document.getElementById('mass-transfer-list'),
    massTransferConfirmBtn: document.getElementById('mass-transfer-confirm-btn'),
    massTransferSetAllStatus: document.getElementById('mass-transfer-set-all-status'),

    // Adicionar GIAP Customizada
    addGiapNumber: document.getElementById('add-giap-number'),
    addGiapName: document.getElementById('add-giap-name'),
    saveGiapUnitBtn: document.getElementById('save-giap-unit-btn'),

    // INÍCIO DA ALTERAÇÃO: IDs do novo Modal de Ligação Manual
    manualLinkModal: document.getElementById('manual-link-modal'),
    manualLinkPastedItem: document.getElementById('manual-link-pasted-item'),
    manualLinkUnitName: document.getElementById('manual-link-unit-name'),
    manualLinkSystemItemSelect: document.getElementById('manual-link-system-item-select'),
    manualLinkUpdateDesc: document.getElementById('manual-link-update-desc'),
    manualLinkConfirmBtn: document.getElementById('manual-link-confirm-btn'),
    // FIM DA ALTERAÇÃO
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
        DOM_IMPORT.replaceTipo,
        // DOM_IMPORT.editByDescTipo // Removido
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
    // *** CORREÇÃO: patrimonioFullList removido deste escopo ***
    tipoSelectEl.addEventListener('change', () => {
        // *** CORREÇÃO: patrimonioFullList é obtido de getState() AQUI DENTRO ***
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

// --- INÍCIO DA ALTERAÇÃO: Funções da Lógica "Editar por Descrição" ---

/**
 * ETAPA 1: Renderiza a UI de Mapeamento de Unidades.
 * @param {Map<string, string>} unitsToMatch - Mapa de "unidade colada" -> "melhor palpite do sistema".
 */
function renderUnitMatchingUI(unitsToMatch) {
    const { normalizedSystemUnits } = getState();
    const systemUnits = [...normalizedSystemUnits.values()].sort();
    
    const systemUnitOptions = `<option value="">-- Ignorar Unidade --</option>` + 
                              systemUnits.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');

    let tableHtml = `
        <table class="w-full text-sm">
            <thead class="bg-slate-200">
                <tr>
                    <th class="p-2 text-left">Unidade na Planilha (Colada)</th>
                    <th class="p-2 text-left">Unidade Correspondente no Sistema</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // INÍCIO DA CORREÇÃO DE BUG: Filtrar o item "unidade"
    unitsToMatch.forEach((bestMatch, pastedUnit) => {
        if (normalizeStr(pastedUnit) === 'unidade') return; // Ignora o próprio cabeçalho

        tableHtml += `
            <tr class="border-b" data-pasted-unit="${escapeHtml(pastedUnit)}">
                <td class="p-2 font-medium">${escapeHtml(pastedUnit)}</td>
                <td class="p-2">
                    <select class="unit-mapping-select w-full p-2 border rounded-lg bg-white">
                        ${systemUnitOptions}
                    </select>
                </td>
            </tr>
        `;
    });
    // FIM DA CORREÇÃO DE BUG
    
    tableHtml += `</tbody></table>`;
    DOM_IMPORT.editByDescUnitTableContainer.innerHTML = tableHtml;

    // Pré-seleciona a melhor correspondência encontrada
    unitsToMatch.forEach((bestMatch, pastedUnit) => {
        const select = DOM_IMPORT.editByDescUnitTableContainer.querySelector(`tr[data-pasted-unit="${escapeHtml(pastedUnit)}"] select`);
        if (select && bestMatch) {
            select.value = bestMatch;
        }
    });

    // Mostra a etapa 2 e esconde a 3
    DOM_IMPORT.editByDescUnitMatching.classList.remove('hidden');
    DOM_IMPORT.editByDescResults.classList.add('hidden');
}


/**
 * ETAPA 2: Processa o mapeamento de unidades e prepara os dados de comparação de itens.
 */
function processUnitMappingAndLoadItems() {
    const { patrimonioFullList } = getState();
    
    // 1. Lê o mapeamento final da UI
    multiUnitImportData.unitMap.clear();
    const mappingRows = DOM_IMPORT.editByDescUnitTableContainer.querySelectorAll('tr[data-pasted-unit]');
    mappingRows.forEach(row => {
        const pastedUnit = row.dataset.pastedUnit;
        const selectedSystemUnit = row.querySelector('.unit-mapping-select').value;
        if (pastedUnit && selectedSystemUnit) {
            multiUnitImportData.unitMap.set(pastedUnit, selectedSystemUnit);
        }
    });

    if (multiUnitImportData.unitMap.size === 0) {
        showNotification('Nenhuma unidade foi mapeada. Processo interrompido.', 'warning');
        return;
    }

    // 2. Prepara os dados de comparação e o pool de S/T para ligação manual
    multiUnitImportData.comparisonData = [];
    multiUnitImportData.stItemsInManualLinkPool.clear(); // Limpa o pool de S/T

    // Agrupa os itens do sistema por unidade para performance e prepara o pool S/T
    const systemItemsByUnit = new Map();
    multiUnitImportData.unitMap.forEach(systemUnit => {
        if (!systemItemsByUnit.has(systemUnit)) {
            const items = [...patrimonioFullList.filter(i => normalizeStr(i.Unidade) === normalizeStr(systemUnit))];
            systemItemsByUnit.set(systemUnit, items);

            // Preenche o pool S/T para ligação manual para esta unidade (REGRA 3)
            const stItems = items.filter(i => {
                const tombo = normalizeTombo(i.Tombamento);
                const isNoTombo = (tombo === 's/t' || tombo === '');
                const isNotPermuta = !i.isPermuta;
                return isNoTombo && isNotPermuta;
            });
            multiUnitImportData.stItemsInManualLinkPool.set(systemUnit, stItems);
        }
    });

    // 3. Itera sobre os itens colados e encontra correspondências
    multiUnitImportData.pasted.forEach(pastedItem => {
        const pastedUnitName = pastedItem.unidade || '';
        const systemUnitName = multiUnitImportData.unitMap.get(pastedUnitName);

        // --- FILTRO DE ENTRADA RÍGIDO (REGRA DE NEGÓCIO) ---
        const pastedTombo = normalizeTombo(pastedItem.tombamento || pastedItem.tombo || '');

        // 1. Descarta se não é tombo numérico (REGRA DO USUÁRIO)
        if (pastedTombo === 's/t' || pastedTombo === '' || pastedTombo.toLowerCase().includes('permuta') || isNaN(pastedTombo)) {
             return; 
        }

        // 2. Descarta se a unidade não foi mapeada ou foi ignorada
        if (!systemUnitName) {
            return;
        }

        let itemsPool = systemItemsByUnit.get(systemUnitName);
        if (!itemsPool) {
            return;
        }
        
        // Passa a "piscina" de itens para o findBestMatch
        const { match, score, reason } = findBestMatch(pastedItem, itemsPool);
        
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
                systemUnitName, 
                updateDescription: false
            };
            multiUnitImportData.comparisonData.push(comparisonRow);
        } else if (match !== null) {
             // Caso Match Forte (Verde) - Permite passar para ação de atualização
            const matchIndex = itemsPool.findIndex(item => item.id === match.id);
            if (matchIndex > -1) {
                // Remove o item encontrado para não ser usado em outro match da planilha
                itemsPool.splice(matchIndex, 1);
            }
            
            const comparisonRow = { 
                pastedItem, 
                bestMatch: match, 
                score, 
                systemUnitName, 
                updateDescription: false
            };
            multiUnitImportData.comparisonData.push(comparisonRow);
        }
        // Qualquer outro caso (Match fraco, falha no filtro rigoroso) é descartado para "lista limpa".
    });

    // 4. Renderiza a tabela de revisão de itens (Etapa 3)
    renderEditByDescPreview(multiUnitImportData.comparisonData, multiUnitImportData.fieldUpdates);
    
    // Mostra a etapa 3 e esconde a 2
    DOM_IMPORT.editByDescResults.classList.remove('hidden');
    DOM_IMPORT.editByDescUnitMatching.classList.add('hidden');
    document.getElementById('edit-by-desc-preview-count').textContent = multiUnitImportData.comparisonData.length;
}


// INÍCIO DA ALTERAÇÃO: Lógica de match focada em Tombo Exato OU Match Rígido (S/T)
/**
 * Encontra a melhor correspondência para a planilha: Tombo Exato OU Match Rígido (S/T).
 */
function findBestMatch(pastedItem, itemsPool) {
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
    
    // Neste ponto, o item é um Sobrante/Não Encontrado (Tombo da planilha não está no sistema).
    return { match: null, score: 0, reason: 'Tombo Não Encontrado no Sistema' };
}
// FIM DA ALTERAÇÃO


/**
 * Renderiza a tabela de comparação para "Editar por Descrição". (Req B)
 * @param {Array<object>} comparisonData - Dados processados da comparação.
 * @param {object} fieldUpdates - Objeto {Tombamento: true, ...}
 */
// INÍCIO DA ALTERAÇÃO: Função reescrita para (Req 1, 2, 3)
function renderEditByDescPreview(comparisonData, fieldUpdates) {
    const container = DOM_IMPORT.editByDescPreviewTableContainer;
    container.innerHTML = ''; // Limpa o container

    // (Req 1) Agrupa os dados por unidade do sistema
    const groupedByUnit = comparisonData.reduce((acc, row) => {
        const unitName = row.systemUnitName || 'Unidade Inválida';
        if (!acc[unitName]) {
            acc[unitName] = [];
        }
        acc[unitName].push(row);
        return acc;
    }, {});

    let html = '';

    // Itera sobre cada unidade agrupada
    Object.entries(groupedByUnit).forEach(([systemUnitName, items]) => {
        
        html += `
            <details open class="unit-group-details mb-4 border rounded-lg shadow-sm bg-white">
                <summary class="p-3 font-bold text-lg bg-slate-100 cursor-pointer rounded-t-lg flex justify-between items-center hover:bg-slate-200">
                    <span>Unidade: ${escapeHtml(systemUnitName)}</span>
                    <span class="text-sm font-normal bg-blue-100 text-blue-700 px-3 py-1 rounded-full">${items.length} itens</span>
                </summary>
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
        items.forEach((row) => {
            // Encontra o índice global do item para o data-row-index
            const index = comparisonData.indexOf(row);
            const { pastedItem, bestMatch, score, systemUnitName } = row;

            // --- Dados da Planilha ---
            const pastedDesc = escapeHtml(pastedItem.descricao || pastedItem.item || 'S/D');
            const pastedTombo = escapeHtml(pastedItem.tombamento || pastedItem.tombo || 'S/T');
            const pastedLocal = escapeHtml(pastedItem.local || pastedItem.localizacao || 'N/I');
            const pastedEstadoInput = pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular';
            const { estado: pastedEstado, origem: pastedOrigem } = parseEstadoEOrigem(pastedEstadoInput);
            const pastedObs = escapeHtml(pastedItem.observacao || pastedItem.obs || '');

            // (Req 3) Lógica de exibição corrigida (não mostra mais "Ignorado")
            const descHtml = fieldUpdates.Descrição ? `<span class="text-red-600 font-bold">${pastedDesc} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedDesc} (IGNORAR)</span>`;
            // Não deve ter atualização de Tombamento se for Tombo Exato - Limpo, mas o filtro já está na entrada agora.
            const tomboHtml = fieldUpdates.Tombamento ? `<span class="text-red-600 font-bold">${pastedTombo} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedTombo} (IGNORAR)</span>`;
            const localHtml = fieldUpdates.Localização ? `<span class="text-red-600 font-bold">${pastedLocal} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedLocal} (IGNORAR)</span>`;
            const estadoHtml = fieldUpdates.Estado ? `<span class="text-red-600 font-bold">${pastedEstado} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedEstado} (IGNORAR)</span>`;
            const obsHtml = fieldUpdates.Observação ? `<span class="text-red-600 font-bold">${pastedObs || '...'} (ATUALIZAR)</span>` : `<span class="text-slate-500">${pastedObs || '...'} (IGNORAR)</span>`;
            const origemHtml = `<p><strong>Origem (Auto):</strong> <span class="text-blue-600 font-medium">${escapeHtml(pastedOrigem || 'N/D')}</span></p>`;


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
                // Correspondência Forte (Verde - Score 1.0)
                rowClass = 'bg-green-50';
                
                // MENSAGEM: Indica se foi por Tombo Exato (o único match possível agora)
                const matchReason = 'Tombo Exato';
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
                    <select class="edit-by-desc-action w-full p-2 border rounded-lg bg-white" data-system-id="${bestMatch.id}">
                        <option value="update" selected>Atualizar Campos Marcados</option>
                        <option value="ignore">Ignorar</option>
                    </select>
                `;
            } else {
                // Não Encontrado (Vermelho) - Item Sobrando (Tombo não existe no sistema)
                rowClass = 'bg-red-50';
                
                systemHtml = `<p class="font-semibold text-red-700">Tombo ${pastedTomboNormalizado} não encontrado no sistema.</p>`;
                
                actionHtml = `
                    <div class="space-y-1">
                        <select class="edit-by-desc-action w-full p-2 border rounded-lg bg-white" data-system-id="new-item-${index}">
                            <option value="create_new" selected>Criar Novo Item (Sobrando)</option>
                            <option value="ignore">Ignorar Linha</option>
                        </select>
                        <!-- BOTÃO DE LIGAÇÃO MANUAL -->
                        <button type="button" class="link-manual-btn w-full bg-yellow-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-yellow-600">Ligar S/T Manualmente</button>
                    </div>
                `;
            }

            html += `
                <tr class="border-b ${rowClass}" data-row-index="${index}">
                    <td class="p-2 align-top"><input type="checkbox" class="edit-by-desc-row-checkbox h-4 w-4" checked></td>
                    <td class="p-2 align-top">${planilhaHtml}</td>
                    <td class="p-2 align-top">${systemHtml}</td>
                    <td class="p-2 align-top">${actionHtml}</td>
                </tr>
            `;
        });

        html += `</tbody></table></div></details>`;
    });

    container.innerHTML = html;

    // Atualiza o sumário
    updateEditByDescSummary();
}
// FIM DA ALTERAÇÃO

/**
 * Atualiza o sumário de ações com base nas seleções atuais.
 */
// INÍCIO DA ALTERAÇÃO: Lógica de contagem atualizada (Req 2)
function updateEditByDescSummary() {
    const selects = DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('select.edit-by-desc-action');
    const notFoundButtons = DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('button.link-manual-btn');
    
    let toUpdateCount = 0;
    let toIgnoreCount = 0;
    let toCreateCount = 0;
    let notFoundCount = notFoundButtons.length; // Conta os botões "Não Encontrado" (que precisam de ação manual)

    selects.forEach(select => {
        if (select.value === 'update') toUpdateCount++;
        else if (select.value === 'ignore') toIgnoreCount++;
        else if (select.value === 'create_new') toCreateCount++;
    });

    DOM_IMPORT.editByDescSummary.textContent = `${toUpdateCount} para ATUALIZAR, ${toIgnoreCount} para IGNORAR, ${toCreateCount} para CRIAR, ${notFoundCount} MANUAIS.`;
    // O botão só fica desabilitado se a soma das ações não for maior que zero
    DOM_IMPORT.confirmEditByDescBtn.disabled = (toUpdateCount + toCreateCount) === 0;
}
// FIM DA ALTERAÇÃO

// INÍCIO DA ALTERAÇÃO: (Req 2) Funções para o Modal de Ligação Manual (MODIFICADA PARA INCLUIR ESTADO E LOCAL)
/**
 * Abre o modal para ligar manualmente um item "Não Encontrado".
 * @param {number} rowIndex - O índice do item em `multiUnitImportData.comparisonData`.
 */
function openManualLinkModal(rowIndex) {
    selPastedItemIndex = rowIndex; // Armazena o índice
    const { patrimonioFullList } = getState();
    const { pastedItem, systemUnitName } = multiUnitImportData.comparisonData[rowIndex];

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
    const allStCandidatesPool = multiUnitImportData.stItemsInManualLinkPool.get(systemUnitName) || [];
    
    let systemItems = allStCandidatesPool;
    let locationMatch = false;

    // 1. Aplica Filtro de Localização Rígida (Se a planilha tiver Local, só mostra itens desse Local)
    if (pastedLocal && pastedLocal !== 'n/a' && pastedLocal !== 'n/i') {
        const filteredByLocation = allStCandidatesPool.filter(item => 
            normalizeStr(item.Localização) === pastedLocal
        );
        // O filtro rígido: Se o local for especificado na planilha, a lista de sugestões SÓ PODE ter itens desse local.
        systemItems = filteredByLocation;
        locationMatch = filteredByLocation.length > 0;
    } 

    // 2. Aplica Filtro de Similaridade e Ordenação 
    const pastedDesc = normalizeStr(pastedItem.descricao || pastedItem.item || '');

    const candidatesWithScore = systemItems.map(item => {
        const systemDesc = normalizeStr(item.Descrição);
        const score = calculateSimilarity(pastedDesc, systemDesc);
        
        // 3. Aplica o filtro de Similaridade Mínima (> 0.3)
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
            
            // Verifica o estado para destaque
            const systemEstado = normalizeEstadoConservacao(item.Estado || 'Regular');
            const estadoHighlight = systemEstado === pastedEstado ? 'text-green-600' : 'text-red-600';

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
             // Caso a planilha não tenha Localização, mostra todos os que têm boa similaridade de nome
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
    const pool = multiUnitImportData.stItemsInManualLinkPool.get(unitName);
    if (pool) {
        const index = pool.findIndex(item => item.id === systemId);
        if (index > -1) {
            pool.splice(index, 1);
        }
    }


    // Atualiza a linha de comparação em memória
    const comparisonRow = multiUnitImportData.comparisonData[selPastedItemIndex];
    comparisonRow.bestMatch = systemItem;
    comparisonRow.score = 1.0; // 1.0 para indicar override manual
    comparisonRow.updateDescription = isUpdateDescChecked; // Armazena a escolha

    // Fecha o modal
    DOM_IMPORT.manualLinkModal.classList.add('hidden');
    selPastedItemIndex = null;

    // Re-renderiza a lista de preview
    renderEditByDescPreview(multiUnitImportData.comparisonData, multiUnitImportData.fieldUpdates);
    showNotification('Item ligado manualmente. A linha foi movida para "Atualizar".', 'success');
}

/**
 * Lida com o fechamento/cancelamento do modal de ligação manual.
 */
function handleManualLinkModalClose() {
    // A lógica de retorno ao pool (se necessário) foi movida para a função de confirmação,
    // já que o item só sai do pool quando o link é salvo. 
    // Se o usuário clicar em Cancelar, o item permanece no pool original.
    selPastedItemIndex = null;
    DOM_IMPORT.manualLinkModal.classList.add('hidden');
}


// FIM DA ALTERAÇÃO

// --- LISTENERS ---

export function setupImportacaoListeners(reloadDataCallback) {
    // 1. Setup para selects de unidade
    setupUnitSelect(DOM_IMPORT.massTransferTipo, DOM_IMPORT.massTransferUnit);
    setupUnitSelect(DOM_IMPORT.replaceTipo, DOM_IMPORT.replaceUnit);
    // setupUnitSelect(DOM_IMPORT.editByDescTipo, DOM_IMPORT.editByDescUnit); // Removido

    // 2. Lógica de Importação em Massa
    DOM_IMPORT.massTransferSearchBtn.addEventListener('click', async () => {
        // *** CORREÇÃO: Obtém estado atualizado AQUI DENTRO ***
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
    
    // Definir estado para todos os itens
    DOM_IMPORT.massTransferSetAllStatus.addEventListener('change', (e) => {
        const status = e.target.value;
        document.querySelectorAll('#mass-transfer-list .status-select').forEach(select => {
            select.value = status;
        });
    });

    // Confirmação de Importação em Massa
    DOM_IMPORT.massTransferConfirmBtn.addEventListener('click', async () => {
        // *** CORREÇÃO: Obtém estado atualizado AQUI DENTRO ***
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

    // 3. Lógica para Adicionar Nova Unidade GIAP
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

    // 4. Lógica de Substituir Inventário (Preview e Confirmação)
    DOM_IMPORT.previewReplaceBtn.addEventListener('click', () => {
        const data = DOM_IMPORT.replaceData.value;
        if (!data) return showNotification('Cole os dados do Excel primeiro.', 'warning');
        
        const parsed = Papa.parse(data, { 
            header: true, 
            skipEmptyLines: true, 
            delimiter: '\t', 
            transformHeader: h => normalizeStr(h) // Remove acentos, espaços e converte para minúsculo
        }).data;
        
        if (parsed.length === 0) return showNotification('Nenhum dado válido encontrado.', 'error');
        
        DOM_IMPORT.replaceResults.classList.remove('hidden');
        document.getElementById('replace-preview-count').textContent = parsed.length;
        
        // INÍCIO DA ALTERAÇÃO: Adiciona coluna "Origem da Doação" na pré-visualização
        let previewHtml = `
            <table class="w-full text-sm">
                <thead>
                    <tr class="bg-slate-100">
                        <th class="p-2 text-left">Descrição</th>
                        <th class="p-2 text-left">Tombamento</th>
                        <th class="p-2 text-left">Local</th>
                        <th class="p-2 text-left">Estado</th>
                        <th class="p-2 text-left">Origem (Auto)</th>
                    </tr>
                </thead
                <tbody>
        `;
        
        previewHtml += parsed.map(item => {
            // Usa os nomes de coluna normalizados (sem acento)
            const desc = escapeHtml(item.descricao || item.item || 'S/D');
            const tombo = escapeHtml(item.tombamento || item.tombo || 'S/T');
            const local = escapeHtml(item.local || item.localizacao || 'N/I');
            const estadoInput = item['estado de conservacao'] || item.estado || 'Regular';
            
            // Normaliza o valor do estado
            const estadoNormalizado = normalizeEstadoConservacao(estadoInput);
            
            // Extrai a origem da doação
            const origemDoacao = extractOrigemDoacao(item);
            
            return `
                <tr class="border-b">
                    <td class="p-2">${desc}</td>
                    <td class="p-2 font-mono">${tombo}</td>
                    <td class="p-2">${local}</td>
                    <td class="p-2">
                        <span class="font-semibold text-blue-600">${escapeHtml(estadoNormalizado)}</span>
                        <span class="text-xs text-slate-500" title="Valor original colado">(${escapeHtml(estadoInput)})</span>
                    </td>
                    <td class="p-2 text-green-600 font-medium">${escapeHtml(origemDoacao)}</td>
                </tr>
            `;
        }).join('');

        previewHtml += `</tbody></table>`;
        DOM_IMPORT.replacePreviewList.innerHTML = previewHtml;
        // FIM DA ALTERAÇÃO
        
        DOM_IMPORT.confirmReplaceBtn.disabled = !DOM_IMPORT.replaceConfirmCheckbox.checked;
    });

    DOM_IMPORT.replaceConfirmCheckbox.addEventListener('change', (e) => {
        DOM_IMPORT.confirmReplaceBtn.disabled = !e.target.checked;
    });

    DOM_IMPORT.confirmReplaceBtn.addEventListener('click', async () => {
        const tipo = DOM_IMPORT.replaceTipo.value;
        const unidade = DOM_IMPORT.replaceUnit.value;
        const data = DOM_IMPORT.replaceData.value;

        if (!tipo || !unidade) return showNotification('Selecione o Tipo e a Unidade de destino.', 'warning');
        if (!DOM_IMPORT.replaceConfirmCheckbox.checked) return showNotification('Você deve confirmar a exclusão.', 'warning');

        showOverlay(`Substituindo inventário de ${unidade}...`);
        
        // 1. Parse dos Novos Dados
        const parsed = Papa.parse(data, { 
            header: true, 
            skipEmptyLines: true, 
            delimiter: '\t', 
            transformHeader: h => normalizeStr(h) // Remove acentos, espaços e converte para minúsculo
        }).data;
        
        // 2. Apagar itens existentes
        try {
            const q = query(collection(db, 'patrimonio'), where('Unidade', '==', unidade));
            const snapshot = await getDocs(q);
            const deleteBatch = writeBatch(db);
            snapshot.docs.forEach(doc => deleteBatch.delete(doc.ref));
            await deleteBatch.commit();
            showNotification(`${snapshot.size} itens antigos de ${unidade} apagados.`, 'info');
        } catch (e) {
            hideOverlay();
            showNotification('Erro ao apagar inventário antigo.', 'error');
            console.error(e);
            return;
        }

        // 3. Criar novos itens
        try {
            const createBatch = writeBatch(db);
            const newItemsForCache = [];
            
            parsed.forEach(item => {
                const docRef = doc(collection(db, 'patrimonio'));
                
                // INÍCIO DA ALTERAÇÃO: Lógica de criação de newItem atualizada com origem da doação
                const estadoInput = item['estado de conservacao'] || item.estado || 'Regular';
                const estadoNormalizado = normalizeEstadoConservacao(estadoInput);
                const origemDoacao = extractOrigemDoacao(item);

                const newItem = {
                    id: docRef.id,
                    Tombamento: item.tombamento || item.tombo || 'S/T', 
                    Descrição: item.descricao || item.item || 'Item sem descrição',
                    Tipo: tipo, 
                    Unidade: unidade, 
                    Localização: item.local || item.localizacao || '',
                    Fornecedor: '', 
                    NF: '', 
                    'Origem da Doação': origemDoacao, // Salva a origem extraída
                    Estado: estadoNormalizado, // Salva o estado normalizado
                    Quantidade: 1, 
                    Observação: `Substituição em massa. (Estado original: ${estadoInput})`,
                    isPermuta: false,
                    createdAt: serverT(), 
                    updatedAt: serverT()
                };
                // FIM DA ALTERAÇÃO

                createBatch.set(docRef, newItem);
                newItemsForCache.push(newItem);
            });

            await createBatch.commit();
            // Atualiza o cache local (idb)
            const oldItems = await idb.patrimonio.where('Unidade').equals(unidade).toArray();
            await idb.patrimonio.bulkDelete(oldItems.map(i => i.id));
            await idb.patrimonio.bulkAdd(newItemsForCache);
            
            showNotification(`Novo inventário com ${parsed.length} itens criado.`, 'success');
            reloadDataCallback(true); // Força recarregamento completo
        } catch (e) {
            hideOverlay();
            showNotification('Erro ao criar novo inventário.', 'error');
            console.error(e);
        }
    });

    // 5. Lógica de Edição por Descrição (Preview e Confirmação)
    
    // ETAPA 1: Clique em "Pré-visualizar Unidades"
    DOM_IMPORT.previewEditByDescBtn.addEventListener('click', () => {
        // Reseta o estado local
        multiUnitImportData = { pasted: [], unitMap: new Map(), fieldUpdates: {}, comparisonData: [], stItemsInManualLinkPool: new Map() };

        const data = DOM_IMPORT.editByDescData.value;
        if (!data) return showNotification('Cole os dados do Excel primeiro.', 'warning');
        
        // Lê os campos a atualizar
        DOM_IMPORT.editByDescFields.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            multiUnitImportData.fieldUpdates[cb.dataset.field] = cb.checked;
        });
        
        const parsed = Papa.parse(data, { 
            header: true, 
            skipEmptyLines: true, 
            delimiter: '\t', 
            transformHeader: h => normalizeStr(h)
        }).data;
        
        if (parsed.length === 0) return showNotification('Nenhum dado válido encontrado (verifique se o cabeçalho foi colado).', 'error');

        // Verifica se a coluna "UNIDADE" existe
        if (!parsed[0].hasOwnProperty('unidade')) {
            return showNotification('Coluna "UNIDADE" não encontrada na planilha. Esta coluna é obrigatória para esta ferramenta.', 'error');
        }
        
        multiUnitImportData.pasted = parsed;
        const { normalizedSystemUnits } = getState();
        const systemUnits = [...normalizedSystemUnits.values()];

        // Encontra unidades únicas da planilha
        const pastedUnits = new Set(parsed.map(item => item.unidade).filter(Boolean));
        const unitsToMatch = new Map();

        // Tenta encontrar a melhor correspondência
        pastedUnits.forEach(pastedUnit => {
            let bestMatch = '';
            let bestScore = 0;
            const normPasted = normalizeStr(pastedUnit);

            systemUnits.forEach(systemUnit => {
                const score = calculateSimilarity(normPasted, normalizeStr(systemUnit));
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = systemUnit;
                }
            });
            
            // Se a similaridade for alta, sugere
            unitsToMatch.set(pastedUnit, bestScore > 0.7 ? bestMatch : '');
        });
        
        // Renderiza a Etapa 2 (Mapeamento de Unidades)
        renderUnitMatchingUI(unitsToMatch);
    });

    // ETAPA 2: Clique em "Confirmar Unidades e Ver Itens"
    DOM_IMPORT.confirmUnitMappingBtn.addEventListener('click', debounce(processUnitMappingAndLoadItems, 200));

    
    // Listeners para Ações em Massa (Req D)
    if (DOM_IMPORT.editByDescSelectAll) {
        DOM_IMPORT.editByDescSelectAll.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            // INÍCIO DA ALTERAÇÃO: (Req 1) O seletor agora busca em todo o container
            DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('.edit-by-desc-row-checkbox:not(:disabled)').forEach(cb => {
                cb.checked = isChecked;
            });
            // FIM DA ALTERAÇÃO
        });
    }

    if (DOM_IMPORT.editByDescBulkApply) {
        DOM_IMPORT.editByDescBulkApply.addEventListener('click', () => {
            const action = DOM_IMPORT.editByDescBulkAction.value;
            if (!action) return showNotification('Selecione uma ação em massa.', 'warning');

            // INÍCIO DA ALTERAÇÃO: (Req 1) O seletor agora busca em todo o container
            const checkedRows = DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('.edit-by-desc-row-checkbox:checked');
            // FIM DA ALTERAÇÃO
            if (checkedRows.length === 0) return showNotification('Nenhum item selecionado.', 'warning');

            checkedRows.forEach(cb => {
                const row = cb.closest('tr');
                const select = row.querySelector('.edit-by-desc-action');
                if (select && !select.disabled) {
                    select.value = action;
                }
            });
            updateEditByDescSummary(); // Atualiza a contagem
            showNotification(`Ação em massa aplicada a ${checkedRows.length} itens.`, 'info');
        });
    }

    // Listener para mudança individual de ação
    DOM_IMPORT.editByDescPreviewTableContainer.addEventListener('change', (e) => {
        // (Req 1) Listener para "select all" de uma unidade específica
        if (e.target.classList.contains('edit-by-desc-unit-select-all')) {
            const isChecked = e.target.checked;
            const tableBody = e.target.closest('table').querySelector('tbody');
            tableBody.querySelectorAll('.edit-by-desc-row-checkbox:not(:disabled)').forEach(cb => {
                cb.checked = isChecked;
            });
        }
        
        if (e.target.classList.contains('edit-by-desc-action')) {
            updateEditByDescSummary();
        }
    });

    // INÍCIO DA ALTERAÇÃO: (Req 2) Listener para o novo botão "Ligar Manualmente"
    DOM_IMPORT.editByDescPreviewTableContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('link-manual-btn')) {
            const rowIndex = parseInt(e.target.closest('tr').dataset.rowIndex, 10);
            openManualLinkModal(rowIndex);
        }
    });

    // (Req 2) Listeners para o novo modal
    if (DOM_IMPORT.manualLinkConfirmBtn) {
        DOM_IMPORT.manualLinkConfirmBtn.addEventListener('click', confirmManualLink);
    }
    document.body.addEventListener('click', (e) => {
        // Usa a função de fechar dedicada ao modal manual
        if (e.target.matches('.js-close-modal-manual-link') || e.target.matches('#manual-link-modal .modal-overlay')) {
            handleManualLinkModalClose();
        }
    });
    // FIM DA ALTERAÇÃO

    // ETAPA 3: Clique em "Confirmar e Atualizar Itens" (Req C)
    DOM_IMPORT.confirmEditByDescBtn.addEventListener('click', async () => {
        const actionSelects = DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('select.edit-by-desc-action');
        const itemsToUpdate = [];
        const itemsToCreate = []; // Novo array para itens a criar (Req 5)
        const { fieldUpdates, comparisonData } = multiUnitImportData;
        let updateCount = 0; // Contagem para o overlay

        actionSelects.forEach(select => {
            const row = select.closest('tr');
            const rowCheckbox = row.querySelector('.edit-by-desc-row-checkbox');
            const action = select.value;
            
            // --- NOVO CHECK DE SEGURANÇA CRÍTICO (CORREÇÃO DA TRAGÉDIA) ---
            // Ação só é processada se o SELECT não for 'ignore' E o CHECKBOX da linha estiver marcado.
            if (action === 'ignore' || !rowCheckbox || !rowCheckbox.checked) {
                return; 
            }
            // -----------------------------------------------------------------

            const systemId = select.dataset.systemId;
            const rowIndex = parseInt(row.dataset.rowIndex, 10);
            const { pastedItem, bestMatch, updateDescription, systemUnitName } = comparisonData[rowIndex];

            if (action === 'create_new') {
                // Lógica para criar novo item (Sobrando)
                const pastedTombo = normalizeTombo(pastedItem.tombamento || pastedItem.tombo);

                // Permite a criação mesmo sem Tombo (pastedTombo pode ser vazio/S/T)
                updateCount++;
                const docRef = doc(collection(db, 'patrimonio'));
                
                const estadoInput = pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular';
                const estadoNormalizado = normalizeEstadoConservacao(estadoInput);
                const origemDoacao = extractOrigemDoacao(pastedItem);

                const newItem = {
                    id: docRef.id,
                    Tombamento: pastedTombo, // O filtro de entrada garante que é numérico aqui
                    Descrição: pastedItem.descricao || pastedItem.item || 'Item sem descrição',
                    // Tipo é incerto, usamos N/A ou o tipo de outra unidade similar
                    Tipo: 'N/A (AUDITORIA)', 
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
                // Lógica de atualização (Item encontrado)
                if (systemId && pastedItem && bestMatch) {
                    updateCount++;
                    // Constrói o objeto de 'changes' com base nos campos selecionados
                    const changes = { updatedAt: serverT() };
                    let obs = bestMatch.Observação || '';
                    
                    // Nota: O Tombamento não é atualizado se foi ligado manualmente (apenas S/T pode ter sido ligado), 
                    // mas como o filtro de entrada agora só aceita tombos, esta lógica se simplifica:
                    
                    if (fieldUpdates.Tombamento) {
                        changes.Tombamento = pastedItem.tombamento || pastedItem.tombo;
                    }
                    if (fieldUpdates.Localização) {
                        changes.Localização = pastedItem.local || pastedItem.localizacao || '';
                    }
                    if (fieldUpdates.Estado) {
                        changes.Estado = normalizeEstadoConservacao(pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular');
                    }
                    // Adiciona a Origem da Doação (REGRA DO USUÁRIO)
                    // if (fieldUpdates['Origem da Doação']) { // Mesmo se não tiver checkbox, forçamos a atualização se vier do manual link
                         changes['Origem da Doação'] = extractOrigemDoacao(pastedItem);
                    // }
                    // Verifica a flag de ligação manual para forçar a atualização da descrição
                    if (fieldUpdates.Descrição || updateDescription) {
                        changes.Descrição = pastedItem.descricao || pastedItem.item || 'S/D';
                    }
                    
                    if (fieldUpdates.Observação) {
                        // Substitui a observação antiga
                        changes.Observação = pastedItem.observacao || pastedItem.obs || '';
                    }
                    
                    // Adiciona uma nota de auditoria
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
            // Mensagem de erro atualizada
            return showNotification('Nenhum item foi marcado (checkbox) para "Atualizar" ou "Criar Novo Item".', 'info');
        }

        showOverlay(`Processando ${itemsToUpdate.length} atualizações e ${itemsToCreate.length} criações...`);
        const batch = writeBatch(db);
        const newItemsForCache = [];
        const updatedItemIds = []; // IDs dos itens atualizados para limpar da UI

        // Adiciona atualizações ao batch
        itemsToUpdate.forEach(item => {
            const docRef = doc(db, 'patrimonio', item.id);
            batch.update(docRef, item.changes);
            updatedItemIds.push(item.id);
        });

        // Adiciona criações ao batch
        itemsToCreate.forEach(item => {
            batch.set(item.docRef, item.data);
            newItemsForCache.push(item.data);
        });

        try {
            await batch.commit();
            
            // Atualiza cache (apenas com os novos, o reload se encarrega do resto)
            if (newItemsForCache.length > 0) {
                await idb.patrimonio.bulkAdd(newItemsForCache);
            }
            
            // Limpa o cache para forçar o reload (apenas metadados)
            await idb.metadata.clear(); 
            
            showNotification(`${updateCount} ações concluídas!`, 'success');
            
            // --- INÍCIO DA CORREÇÃO: Não recarrega, apenas limpa o estado ---
            
            // 1. Remove os itens do estado local 'comparisonData'
            const processedItemIndices = itemsToUpdate.map(item => comparisonData.findIndex(row => row.bestMatch && row.bestMatch.id === item.id))
                                       .concat(itemsToCreate.map(item => comparisonData.findIndex(row => row.pastedItem.tombamento === normalizeTombo(item.data.Tombamento))));
            
            // Remove os itens processados da lista de dados comparativos (de trás para frente)
            processedItemIndices.sort((a, b) => b - a).filter(index => index > -1).forEach(index => {
                 multiUnitImportData.comparisonData.splice(index, 1);
            });
            
            // 2. Re-renderiza a lista de preview
            if(multiUnitImportData.comparisonData.length > 0) {
                 renderEditByDescPreview(multiUnitImportData.comparisonData, multiUnitImportData.fieldUpdates);
                 // O total de itens é atualizado dentro da função renderEditByDescPreview
            } else {
                 // Reseta a UI da aba
                 DOM_IMPORT.editByDescResults.classList.add('hidden');
                 DOM_IMPORT.editByDescUnitMatching.classList.add('hidden');
                 DOM_IMPORT.editByDescData.value = '';
                 multiUnitImportData = { pasted: [], unitMap: new Map(), fieldUpdates: {}, comparisonData: [], stItemsInManualLinkPool: new Map() }; // Reseta estado local
                 showNotification('Todas as ações selecionadas foram salvas. Recarregue a página para começar um novo lote.', 'info');
            }
            
            // 3. Força o recarregamento do estado global para refletir as mudanças nas outras abas
            reloadDataCallback(); 
            
            // --- FIM DA CORREÇÃO ---
            
        } catch (error) {
            hideOverlay();
            showNotification('Erro ao salvar as atualizações/criações.', 'error');
            console.error('Erro ao atualizar itens:', error);
        }
    });
}
