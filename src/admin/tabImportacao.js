/**
 * /src/admin/tabImportacao.js
 * Lógica da aba "Importação e Substituição" (content-importacao).
 * * ATUALIZAÇÃO: Adicionada a sub-aba "Substituir Unidades em Massa"
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

// Estado local para a importação (Aba "Importar e Atualizar Unidade")
let importData = {
    pasted: [], // Todos os itens colados
    selectedUnitName: null, // A unidade de destino selecionada
    fieldUpdates: {}, // Campos a atualizar: { Tombamento: true, ... }
    comparisonData: [], // Dados de comparação item-a-item
    stItemsInManualLinkPool: new Map(), // Pool de itens S/T do sistema disponíveis para ligação manual
};

// Estado local para a NOVA funcionalidade (Aba "Substituir Unidades em Massa")
let bulkReplaceState = {
    pasted: [], // Todos os itens colados (RAW)
    pastedItemsByUnit: new Map(), // Itens da planilha, agrupados por nome de unidade
    systemItemsByUnit: new Map(), // Itens do Sistema, agrupados por nome de unidade
    suggestedMappings: new Map(), // Mapeamento sugerido (pastedUnit -> systemUnit)
    previewActions: [], // Ações geradas (CREATE, UPDATE, DELETE)
    selectedTipo: null, // Tipo de unidade selecionado (Contexto)
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
    
    // --- NOVOS ELEMENTOS DOM PARA SUBSTITUIÇÃO EM MASSA (Refatorados) ---
    bulkReplaceTipo: document.getElementById('bulk-replace-tipo'),
    bulkReplaceData: document.getElementById('bulk-replace-data'),
    previewBulkReplaceBtn: document.getElementById('preview-bulk-replace-btn'),
    bulkReplaceResults: document.getElementById('bulk-replace-results'),
    bulkReplaceMappingContainer: document.getElementById('bulk-replace-mapping-container'),
    generateBulkActionsBtn: document.getElementById('generate-bulk-actions-btn'), // ID do novo botão
    bulkReplacePreviewContainer: document.getElementById('bulk-replace-preview-container'), // NOVO container
    bulkReplaceSummary: document.getElementById('bulk-replace-summary'),
    bulkReplacePreviewTableContainer: document.getElementById('bulk-replace-preview-table-container'),
    bulkReplaceConfirmCheckbox: document.getElementById('bulk-replace-confirm-checkbox'),
    confirmBulkReplaceBtn: document.getElementById('confirm-bulk-replace-btn'),
    // --------------------------------------------------------

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
        DOM_IMPORT.importTipo, // Adicionado
        DOM_IMPORT.bulkReplaceTipo // NOVO
    ];

    selects.forEach(select => {
        if(select) select.innerHTML = '<option value="">Selecione um Tipo</option>' + tipos.map(t => `<option value="${t}">${t}</option>`).join('');
    });
    
    // Configura o select de unidade para a aba "Importar e Atualizar Unidade"
    setupUnitSelect(DOM_IMPORT.importTipo, DOM_IMPORT.importUnit);
    
    // Configura o select de unidade para a aba "Importar por Tombamento"
    setupUnitSelect(DOM_IMPORT.massTransferTipo, DOM_IMPORT.massTransferUnit);
    
    // Configura o select de tipo para a aba "Substituir Unidades em Massa"
    setupUnitSelect(DOM_IMPORT.bulkReplaceTipo, null); // Só o Tipo
}

/**
 * Lógica para popular dinamicamente os selects de Unidade com base no Tipo.
 * @param {HTMLSelectElement} tipoSelectEl - Elemento do select de Tipo.
 * @param {HTMLSelectElement | null} unitSelectEl - Elemento do select de Unidade (opcional).
 */
function setupUnitSelect(tipoSelectEl, unitSelectEl) {
    tipoSelectEl.addEventListener('change', () => {
        const { patrimonioFullList } = getState();
        const selectedTipo = tipoSelectEl.value;
        
        // Se houver um select de unidade acoplado, popula-o
        if (unitSelectEl) {
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
        }
        
        // Lógica específica para a aba "Substituir Unidades" (que não tem unitSelectEl acoplado)
        if(tipoSelectEl.id === 'bulk-replace-tipo') {
            // Reseta o estado se o tipo mudar
            bulkReplaceState = { ...bulkReplaceState, selectedTipo: selectedTipo, pasted: [], previewActions: [], pastedItemsByUnit: new Map(), systemItemsByUnit: new Map() };
            DOM_IMPORT.bulkReplaceResults.classList.add('hidden');
            DOM_IMPORT.bulkReplaceData.value = '';
        }
    });
}

// --- Funções da Lógica "Importar e Atualizar Unidade" (edit-by-desc) ---

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
        
        // Se deu match Tombo Exato E Limpo (sem divergência), DESCARTA (REGRA DO USUÁRIO - REQUISITO 3)
        if (reason === 'Tombo Exato - Limpo') {
            return;
        }

        if (match === null && reason.includes('Tombo Não Encontrado no Sistema')) {
             // Caso Sobrando (Vermelho) - Permite passar para ação de criação
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
 *
 * REQUISITO 2 (MELHORIA DO ALGORITMO): Garantir que Tombo Exato com divergência apareça.
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
            
            // Define se há divergência nos metadados (Descrição, Local, Estado, NF, Fornecedor)
            const systemDesc = normalizeStr(exactTomboMatch.Descrição);
            const giapDesc = normalizeStr(pastedItem.descricao || pastedItem.item || '');
            const systemLocal = normalizeStr(exactTomboMatch.Localização);
            const giapLocal = normalizeStr(pastedItem.local || pastedItem.localizacao || '');
            const systemEstado = normalizeEstadoConservacao(exactTomboMatch.Estado);
            const giapEstado = normalizeEstadoConservacao(pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular');
            // Adicionando checagem de Fornecedor e NF para rigidez na divergência
            const systemFornecedor = normalizeStr(exactTomboMatch.Fornecedor);
            const giapFornecedor = normalizeStr(pastedItem.fornecedor || '');
            const systemNF = normalizeStr(exactTomboMatch.nf || '');
            const giapNF = normalizeStr(pastedItem.nf || '');

            const hasSignificantDivergence = 
                systemDesc !== giapDesc || 
                systemLocal !== giapLocal || 
                systemEstado !== giapEstado ||
                systemFornecedor !== giapFornecedor ||
                systemNF !== giapNF;
            
            if (!hasSignificantDivergence) {
                 // REQUISITO 3: Tombo Exato, Sem Divergência: DESCARTA (Limpo)
                 return { match: exactTomboMatch, score: 1.0, reason: 'Tombo Exato - Limpo' };
            }
            
            // REQUISITO 1: Tombo Exato, COM Divergência: APRESENTA PARA REVISÃO
            return { match: exactTomboMatch, score: 1.0, reason: 'Tombo Exato - Divergência' };
        }
    }
    
    // --- NOVO PASSO: BUSCA POR MATCH RÍGIDO em CANDIDATOS S/T ---

    // Filtro de candidatos: APENAS itens S/T (sem Tombo) para LIGAR
    const stCandidates = itemsPool.filter(item => {
        const tombo = normalizeTombo(item.Tombamento);
        // Garante que é S/T e não é permuta
        return (tombo === 's/t' || tombo === '') && !item.isPermuta;
    });

    // 2. Match: Rígido (Local + Estado + Nome Similar) em CANDIDATOS S/T
    let bestStMatch = null;
    let maxStScore = 0;
    
    // REQUISITO 2 (MELHORIA): Iterar todos os S/T e escolher o de maior score com peso em Local/Estado.
    for (const systemItem of stCandidates) {
        const systemDesc = normalizeStr(systemItem.Descrição);
        const systemLocal = normalizeStr(systemItem.Localização);
        const systemEstado = normalizeEstadoConservacao(systemItem.Estado);
        
        // Peso de 0.5 para similaridade de nome
        const nameScore = calculateSimilarity(pastedDesc, systemDesc) * 0.5;
        let finalScore = nameScore;

        // Bônus rigoroso para Localização
        if (systemLocal === pastedLocal && systemLocal.length > 2) {
            finalScore += 0.3; // Grande bônus (30%) se o local for exato
        } else if (systemLocal.includes(pastedLocal) || pastedLocal.includes(systemLocal)) {
             finalScore += 0.15; // Bônus médio (15%) se o local contiver
        }
        
        // Bônus para Estado
        if (systemEstado === pastedEstado) {
            finalScore += 0.15; // Bônus (15%) se o estado for exato
        }

        // Se o score final for alto o suficiente (> 0.95), consideramos match forte
        if (finalScore >= 0.95) {
             if (finalScore > maxStScore) {
                 maxStScore = finalScore;
                 bestStMatch = systemItem;
             }
        }
    }
    
    if (bestStMatch) {
         return { match: bestStMatch, score: maxStScore, reason: 'Match Forte em S/T' };
    }

    // --- 3. Falha: Sobrando ---
    return { match: null, score: 0, reason: 'Tombo Não Encontrado no Sistema' };
}


/**
 * Renderiza a tabela de comparação para "Importar e Atualizar Unidade".
 *
 * REQUISITO 1: Inclui select para escolha de descrição.
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
            // Lógica de filtro para a UI
            let currentAction = row.finalAction || (row.bestMatch ? 'update' : 'create_new');
            // Se for Tombo Exato - Limpo (já filtrado na fonte), não deve aparecer aqui.
            // Se for Tombo Exato - Divergência, a ação deve ser 'update'.
            if (row.bestMatch && row.score === 1.0 && row.reason === 'Tombo Exato - Divergência') currentAction = 'update'; 
            
            if (actionFilter === 'all') return true;
            
            if (actionFilter === 'manual') {
                 return currentAction === 'create_new' && row.bestMatch === null;
            }
            
            return currentAction === actionFilter;
        });

        if (filteredItems.length === 0) return; 

        // Adiciona cabeçalho da tabela
        html += `
                <div class="p-2 overflow-x-auto">
                    <table class="w-full text-sm min-w-[900px]">
                        <thead class="bg-slate-50">
                            <tr>
                                <th class="p-2 text-left w-10"><input type="checkbox" class="h-4 w-4 edit-by-desc-unit-select-all" title="Selecionar todos nesta unidade"></th>
                                <th class="p-2 text-left">Sua Planilha (Item Colado)</th>
                                <th class="p-2 text-left">Sistema (Item Encontrado)</th>
                                <th class="p-2 text-left w-64">Ação</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        // Itera sobre os itens *dentro* de cada unidade
        filteredItems.forEach((row) => {
            const index = comparisonData.indexOf(row);
            const { pastedItem, bestMatch, score, systemUnitName, finalAction } = row;
            
            // Determina a ação que será exibida (prioriza finalAction se setado)
            const currentRenderAction = finalAction || (bestMatch ? 'update' : 'create_new');

            // --- Dados da Planilha ---
            const pastedDesc = escapeHtml(pastedItem.descricao || pastedItem.item || 'S/D');
            const pastedTombo = escapeHtml(pastedItem.tombamento || pastedItem.tombo || 'S/T');
            const pastedLocalInput = pastedItem.local || pastedItem.localizacao || '';
            const pastedEstadoInput = pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular';
            const { estado: pastedEstado, origem: pastedOrigem } = parseEstadoEOrigem(pastedEstadoInput);
            const pastedObs = escapeHtml(pastedItem.observacao || pastedItem.obs || '');
            
            // --- Campos a serem ATUALIZADOS pela Planilha (highlight) ---
            const tomboHtml = `<span class="text-red-600 font-bold">${pastedTombo}</span>`;
            
            // Conteúdo da Planilha (sempre em vermelho para destacar o que será copiado)
            let planilhaHtml = `
                <p class="font-semibold text-red-600">${pastedDesc}</p>
                <p><strong>Tombo:</strong> ${tomboHtml}</p>
                <p><strong>Local:</strong> <span class="text-red-600 font-bold">${escapeHtml(pastedLocalInput || 'N/I')}</span></p>
                <p><strong>Estado:</strong> <span class="text-red-600 font-bold">${escapeHtml(pastedEstado)}</span></p>
                <p><strong>Origem:</strong> <span class="text-red-600 font-bold">${escapeHtml(pastedOrigem || 'N/D')}</span></p>
                <p class="text-xs text-blue-600 mt-1">Planilha: ${escapeHtml(pastedItem.unidade)}</p>
            `;

            let rowClass = '';
            let systemHtml = '';
            let actionHtml = '';
            
            const pastedTomboNormalizado = normalizeTombo(pastedItem.tombamento || pastedItem.tombo);


            if (bestMatch) {
                // Correspondência Forte (Verde)
                rowClass = 'bg-green-50';
                
                const matchReason = score >= 1.0 ? 'Tombo Exato (Divergência)' : `Match S/T (Score: ${score.toFixed(2)})`;
                const systemOrigem = bestMatch['Origem da Doação'] || 'N/D';
                
                systemHtml = `
                    <p class="font-semibold text-green-800">${escapeHtml(bestMatch.Descrição)}</p>
                    <p><strong>Tombo Atual:</strong> ${escapeHtml(bestMatch.Tombamento)}</p>
                    <p><strong>Local Atual:</strong> ${escapeHtml(bestMatch.Localização)}</p>
                    <p><strong>Estado Atual:</strong> ${escapeHtml(bestMatch.Estado)}</p>
                    <p><strong>Origem Atual:</strong> <span class="text-slate-700 font-medium">${escapeHtml(systemOrigem)}</span></p>
                    <p class="text-xs text-slate-500 mt-1">ID: ${bestMatch.id} | Motivo: ${matchReason}</p>
                `;
                
                // REQUISITO 1: Adicionar select de escolha de descrição para itens que serão atualizados
                const systemDesc = escapeHtml(bestMatch.Descrição);
                const giapDesc = escapeHtml(pastedItem.descricao || pastedItem.item || 'S/D');

                const selectDescHtml = `
                    <div class="mt-2">
                        <label class="block text-xs font-semibold text-slate-600 mb-1">Manter ou Alterar Descrição:</label>
                        <select class="desc-choice-action w-full p-2 border border-blue-300 rounded-lg bg-blue-50 text-sm" data-system-id="${bestMatch.id}" data-row-index="${index}">
                            <option value="use_system">Manter: ${systemDesc}</option>
                            <option value="use_giap" ${score < 1.0 ? 'selected' : ''}>Alterar: ${giapDesc}</option>
                        </select>
                    </div>
                `;
                
                // Se foi ligado manualmente (no modal), a escolha já foi feita
                const isManualLink = finalAction === 'update' && row.updateDescription !== undefined;
                if(isManualLink) {
                    // SEÇÃO ALTERADA AQUI: Torna o status visualmente FIXO.
                    const finalDesc = row.updateDescription ? 'Planilha (Manual)' : 'Sistema (Manual)';
                    const finalClass = row.updateDescription ? 'text-blue-700' : 'text-yellow-700';
                    actionHtml = `
                        <div class="p-3 bg-slate-200 border-l-4 border-slate-500 rounded-lg">
                           <p class="text-xs font-semibold text-slate-700 mb-1">Status Fixo:</p>
                           <p class="font-bold ${finalClass}">Manual: ${finalDesc}</p>
                           <input type="hidden" class="edit-by-desc-action" value="update" data-system-id="${bestMatch.id}" data-row-index="${index}">
                           <input type="hidden" class="manual-desc-choice" value="${row.updateDescription ? 'use_giap' : 'use_system'}">
                        </div>
                    `;
                } else {
                    // ALTERAÇÃO: Adicionando classes visuais para o select de Ação Principal
                    actionHtml = `
                        <div class="space-y-3">
                            <label class="block text-xs font-semibold text-slate-600">Ação Principal:</label>
                            <select class="edit-by-desc-action w-full p-2 border border-green-500 rounded-lg bg-green-100 font-semibold" data-system-id="${bestMatch.id}" data-row-index="${index}">
                                <option value="update" ${currentRenderAction === 'update' ? 'selected' : ''}>Atualizar Campos</option>
                                <option value="ignore" ${currentRenderAction === 'ignore' ? 'selected' : ''}>Ignorar</option>
                            </select>
                            ${selectDescHtml}
                        </div>
                    `;
                }

            } else {
                // Não Encontrado (Vermelho) - Item Sobrando (Tombo não existe no sistema)
                rowClass = 'bg-red-50';
                
                systemHtml = `<p class="font-semibold text-red-700">Tombo ${pastedTomboNormalizado} não encontrado no sistema.</p>`;
                
                // ALTERAÇÃO: Adicionando classes visuais para o select de Criação/Ligação
                actionHtml = `
                    <div class="space-y-2">
                        <label class="block text-xs font-semibold text-slate-600">Ação Principal (Não Encontrado):</label>
                        <select class="edit-by-desc-action w-full p-2 border border-red-500 rounded-lg bg-red-100 font-semibold" data-system-id="new-item-${index}" data-row-index="${index}">
                            <option value="create_new" ${currentRenderAction === 'create_new' ? 'selected' : ''}>Criar Novo Item (Sobrando)</option>
                            <option value="ignore" ${currentRenderAction === 'ignore' ? 'selected' : ''}>Ignorar Linha</option>
                        </select>
                        <button type="button" class="link-manual-btn w-full bg-yellow-500 text-white px-3 py-2 rounded-lg text-sm hover:bg-yellow-600 font-bold mt-2">Ligar S/T Manualmente</button>
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
        // REQUISITO 2: Usar a nova lógica de similaridade que favorece Local/Estado
        // Simulando o cálculo de findBestMatch para ranqueamento
        const systemLocal = normalizeStr(item.Localização);
        const systemEstado = normalizeEstadoConservacao(item.Estado);
        
        const nameScore = calculateSimilarity(pastedDesc, systemDesc) * 0.5;
        let finalScore = nameScore;

        if (systemLocal === pastedLocal && systemLocal.length > 2) finalScore += 0.3;
        else if (systemLocal.includes(pastedLocal) || pastedLocal.includes(systemLocal)) finalScore += 0.15;
        if (systemEstado === pastedEstado) finalScore += 0.15;
        
        if (finalScore < 0.3) return null; 

        return {
            item,
            score: finalScore
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
             filterMessage.innerHTML = `Localização da planilha não especificada. Listando todos os ${candidatesWithScore.length} itens S/T com similaridade de nome e bônus por Local/Estado.`;
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
    
    // ATUALIZAÇÃO: Seta bestMatch para a linha de "Não Encontrado" e define a ação final como update
    comparisonRow.bestMatch = systemItem;
    comparisonRow.score = 1.0; // 1.0 para indicar override manual
    comparisonRow.updateDescription = isUpdateDescChecked; // Armazena a escolha (REQUISITO 1)
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

// --- FUNÇÕES DA NOVA ABA "Substituir Unidades em Massa" ---

/**
 * Passo 3: Processa o Excel colado, extrai unidades e prepara para o mapeamento.
 */
function previewBulkReplace() {
    const data = DOM_IMPORT.bulkReplaceData.value;
    const selectedTipo = DOM_IMPORT.bulkReplaceTipo.value;
    
    if (!selectedTipo) {
        return showNotification('Passo 1: Selecione o Tipo de Unidade (Contexto) primeiro.', 'warning');
    }
    if (!data) {
        return showNotification('Passo 2: Cole os dados do Excel primeiro.', 'warning');
    }
    
    const { patrimonioFullList } = getState();
    
    // Reseta o estado
    bulkReplaceState = {
        pasted: [],
        pastedItemsByUnit: new Map(),
        systemItemsByUnit: new Map(),
        suggestedMappings: new Map(),
        previewActions: [],
        selectedTipo: selectedTipo,
    };

    showOverlay('Processando planilha e identificando unidades...');

    const parsed = Papa.parse(data, { 
        header: true, 
        skipEmptyLines: true, 
        delimiter: '\t', 
        transformHeader: h => normalizeStr(h)
    }).data;
    
    if (parsed.length === 0) {
        hideOverlay();
        return showNotification('Nenhum dado válido encontrado (verifique se o cabeçalho foi colado).', 'error');
    }

    bulkReplaceState.pasted = parsed;
    
    // Agrupa itens colados por unidade
    parsed.forEach(item => {
        const unitName = item.unidade?.trim();
        if (!unitName) return;
        if (!bulkReplaceState.pastedItemsByUnit.has(unitName)) {
            bulkReplaceState.pastedItemsByUnit.set(unitName, []);
        }
        bulkReplaceState.pastedItemsByUnit.get(unitName).push(item);
    });
    
    // Agrupa itens do sistema (do TIPO selecionado) por unidade
    const systemUnitsInType = [];
    patrimonioFullList.forEach(item => {
        if (normalizeStr(item.Tipo) === normalizeStr(selectedTipo)) {
            const unitName = item.Unidade?.trim();
            if (!unitName) return;
            
            if (!bulkReplaceState.systemItemsByUnit.has(unitName)) {
                bulkReplaceState.systemItemsByUnit.set(unitName, []);
                systemUnitsInType.push(unitName);
            }
            bulkReplaceState.systemItemsByUnit.get(unitName).push(item);
        }
    });
    
    const pastedUnits = [...bulkReplaceState.pastedItemsByUnit.keys()].sort();
    const systemUnits = systemUnitsInType.sort();
    
    renderBulkReplaceMappingSuggestions(pastedUnits, systemUnits);
    
    DOM_IMPORT.bulkReplaceResults.classList.remove('hidden');
    DOM_IMPORT.bulkReplacePreviewContainer.classList.add('hidden'); // Esconde a pré-visualização (Passo 5)
    DOM_IMPORT.confirmBulkReplaceBtn.disabled = true;
    DOM_IMPORT.bulkReplaceConfirmCheckbox.checked = false;
    
    hideOverlay();
}

/**
 * Passo 4: Renderiza as sugestões de mapeamento.
 */
function renderBulkReplaceMappingSuggestions(pastedUnits, systemUnits) {
    const container = DOM_IMPORT.bulkReplaceMappingContainer;
    container.innerHTML = ''; // Limpa o container
    
    if (pastedUnits.length === 0) {
        container.innerHTML = '<p class="text-red-600">Nenhuma unidade encontrada na planilha colada (verifique a coluna "Unidade").</p>';
        return;
    }
    
    const systemUnitMap = new Map(systemUnits.map(u => [normalizeStr(u), u]));
    
    // Opções do Select (Unidades do Sistema)
    const systemOptions = `<option value="">-- Ignorar esta Unidade --</option>` + 
                          systemUnits.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
    
    let html = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
            <div class="font-semibold text-slate-700">Unidade da Planilha (${pastedUnits.length} Encontradas)</div>
            <div class="font-semibold text-slate-700">Unidade de Destino no Sistema (ID)</div>
    `;

    pastedUnits.forEach(pastedUnit => {
        // Tenta encontrar uma sugestão
        const suggestedSystemUnit = systemUnitMap.get(normalizeStr(pastedUnit));
        
        html += `
            <div class="flex items-center p-2 bg-slate-200 rounded-lg">
                <span class="font-medium text-slate-800">${escapeHtml(pastedUnit)}</span>
                <span class="ml-auto text-xs text-slate-500">(${bulkReplaceState.pastedItemsByUnit.get(pastedUnit).length} itens)</span>
            </div>
            <div>
                <select class="bulk-replace-mapping-select w-full p-2 border rounded-lg bg-white" data-pasted-unit="${escapeHtml(pastedUnit)}">
                    ${systemOptions}
                </select>
            </div>
        `;
        
        // Armazena a sugestão para pré-selecionar
        if (suggestedSystemUnit) {
            bulkReplaceState.suggestedMappings.set(pastedUnit, suggestedSystemUnit);
        }
    });

    html += '</div>';
    container.innerHTML = html;
    
    // Pré-seleciona as sugestões
    container.querySelectorAll('.bulk-replace-mapping-select').forEach(select => {
        const pastedUnit = select.dataset.pastedUnit;
        const suggestion = bulkReplaceState.suggestedMappings.get(pastedUnit);
        if (suggestion) {
            select.value = suggestion;
        }
    });
}

/**
 * Passo 5: Gera as Ações de Sincronização.
 */
function generateBulkReplaceActions() {
    showOverlay('Comparando unidades e gerando ações...');
    
    bulkReplaceState.previewActions = [];
    const mappingSelects = DOM_IMPORT.bulkReplaceMappingContainer.querySelectorAll('.bulk-replace-mapping-select');
    
    let validMappingFound = false;

    mappingSelects.forEach(select => { // CORRIGIDO: Agora itera sobre a NodeList corretamente
        const pastedUnit = select.dataset.pastedUnit; // CORRIGIDO: Usando camelCase
        const confirmedSystemUnit = select.value;

        // Se o usuário selecionou "-- Ignorar --" (value=""), não faz nada
        if (!confirmedSystemUnit) {
            return;
        }
        
        validMappingFound = true; // Marca que pelo menos um mapeamento foi feito

        // Pega os itens da planilha e do sistema para este par
        const pastedItems = bulkReplaceState.pastedItemsByUnit.get(pastedUnit) || [];
        const systemItems = bulkReplaceState.systemItemsByUnit.get(confirmedSystemUnit) || [];
        
        // Mapeia itens do sistema por Tombamento (para lookup rápido)
        const systemItemsByTombo = new Map(systemItems.map(item => [normalizeTombo(item.Tombamento), item]));
        const tombosSystem = new Set(systemItemsByTombo.keys()); // Tombos existentes no sistema (da unidade de destino)

        // --- Loop 1: Itens da Planilha (Criação/Atualização) ---
        pastedItems.forEach(pastedItem => {
            const pastedTombo = normalizeTombo(pastedItem.tombamento || pastedItem.tombo);
            
            if (!pastedTombo || pastedTombo === 's/t') {
                 bulkReplaceState.previewActions.push({ action: 'IGNORE', type: 'Planilha Ignorada', pasted: pastedItem, system: null, reason: 'Item S/T ou sem Tombo.', systemUnitDestino: confirmedSystemUnit });
                 return;
            }

            const systemMatch = systemItemsByTombo.get(pastedTombo);
            
            if (systemMatch) {
                // AÇÃO 1: ATUALIZAR
                bulkReplaceState.previewActions.push({ action: 'UPDATE', type: 'Atualizar Item', pasted: pastedItem, system: systemMatch, reason: 'Tombo encontrado. Dados serão sincronizados.', systemUnitDestino: confirmedSystemUnit, systemTypeDestino: bulkReplaceState.selectedTipo });
                tombosSystem.delete(pastedTombo); // Remove do set de tombos do sistema para a próxima etapa (DELETE)
            } else {
                // AÇÃO 2: CRIAR NOVO
                 bulkReplaceState.previewActions.push({ action: 'CREATE', type: 'Criar Novo Item', pasted: pastedItem, system: null, reason: 'Tombo da planilha não encontrado na unidade de destino.', systemUnitDestino: confirmedSystemUnit, systemTypeDestino: bulkReplaceState.selectedTipo });
            }
        });
        
        // --- Loop 2: Itens do Sistema (Exclusão/Checagem) ---
        // Todos os Tombos remanescentes em tombosSystem são SOBRAS no sistema que não estão na planilha (serão DELETADOS)
        systemItems.forEach(systemItem => {
            const systemTombo = normalizeTombo(systemItem.Tombamento);
            if (tombosSystem.has(systemTombo)) {
                // AÇÃO 3: EXCLUIR (Sobra no Sistema)
                bulkReplaceState.previewActions.push({ action: 'DELETE', type: 'Excluir Item', pasted: null, system: systemItem, reason: 'Item do sistema não encontrado na planilha de origem. Será excluído para sincronia.', systemUnitDestino: confirmedSystemUnit, systemTypeDestino: bulkReplaceState.selectedTipo });
            }
        });
    });
    
    if (!validMappingFound) {
         hideOverlay();
         return showNotification('Nenhum mapeamento de unidade foi confirmado. Verifique o Passo 4.', 'error');
    }

    renderBulkReplacePreview(bulkReplaceState.previewActions);
    DOM_IMPORT.bulkReplacePreviewContainer.classList.remove('hidden');
    
    // Habilita o checkbox de confirmação
    DOM_IMPORT.bulkReplaceConfirmCheckbox.disabled = false;
    DOM_IMPORT.bulkReplaceConfirmCheckbox.checked = false;
    
    hideOverlay();
}

/**
 * Renderiza a pré-visualização das ações em lote.
 */
function renderBulkReplacePreview(actions) {
    const container = DOM_IMPORT.bulkReplacePreviewTableContainer;
    container.innerHTML = '';
    
    let updateCount = 0, createCount = 0, deleteCount = 0, ignoreCount = 0;
    
    // Agrupa por Unidade de Destino
    const groupedByDestUnit = actions.reduce((acc, action) => {
        const unitName = action.systemUnitDestino || 'Ignorados';
        if (!acc[unitName]) acc[unitName] = [];
        acc[unitName].push(action);
        return acc;
    }, {});
    
    let html = '';
    
    Object.keys(groupedByDestUnit).sort().forEach(unitName => {
        if (unitName === 'Ignorados') return; // Lida com ignorados no final
        
        const unitActions = groupedByDestUnit[unitName];
        
        html += `
            <div class="p-2 overflow-x-auto mb-4">
                <h4 class="text-base font-bold text-blue-700 bg-blue-50 p-2 rounded-t-lg">Destino: ${escapeHtml(unitName)}</h4>
                <table class="w-full text-sm min-w-[1000px]">
                    <thead class="bg-slate-50">
                        <tr>
                            <th class="p-2 text-left">Ação</th>
                            <th class="p-2 text-left">Tombo</th>
                            <th class="p-2 text-left">Descrição (Planilha)</th>
                            <th class="p-2 text-left">Local (Planilha)</th>
                            <th class="p-2 text-left">Descrição (Sistema)</th>
                            <th class="p-2 text-left">Local (Sistema)</th>
                            <th class="p-2 text-left">Motivo/Impacto</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        unitActions.forEach(action => {
            const isUpdate = action.action === 'UPDATE';
            const isCreate = action.action === 'CREATE';
            const isDelete = action.action === 'DELETE';
            const isIgnore = action.action === 'IGNORE';
            
            if (isUpdate) updateCount++;
            if (isCreate) createCount++;
            if (isDelete) deleteCount++;
            if (isIgnore) ignoreCount++;
            
            const tombo = normalizeTombo((action.pasted?.tombamento || action.pasted?.tombo) || action.system?.Tombamento);
            const pastedDesc = escapeHtml(action.pasted?.descricao || action.pasted?.item || 'N/A');
            const pastedLocal = escapeHtml(action.pasted?.local || action.pasted?.localizacao || 'N/A');
            const systemDesc = escapeHtml(action.system?.Descrição || 'N/A');
            const systemLocal = escapeHtml(action.system?.Localização || 'N/A');

            let rowClass = 'bg-slate-50';
            if (isUpdate) rowClass = 'bg-green-100/50 hover:bg-green-100';
            if (isCreate) rowClass = 'bg-blue-100/50 hover:bg-blue-100';
            if (isDelete) rowClass = 'bg-red-100/50 hover:bg-red-100';
            if (isIgnore) rowClass = 'bg-gray-100';

            const actionText = isUpdate ? '<span class="font-bold text-green-700">ATUALIZAR</span>' :
                             isCreate ? '<span class="font-bold text-blue-700">CRIAR NOVO</span>' :
                             isDelete ? '<span class="font-bold text-red-700">EXCLUIR</span>' :
                             '<span class="font-bold text-gray-700">IGNORAR</span>';
            
            html += `
                <tr class="border-b ${rowClass}">
                    <td class="p-2">${actionText}</td>
                    <td class="p-2 font-mono text-xs">${tombo}</td>
                    <td class="p-2">${pastedDesc}</td>
                    <td class="p-2 text-xs">${pastedLocal}</td>
                    <td class="p-2 text-sm">${systemDesc}</td>
                    <td class="p-2 text-xs">${systemLocal}</td>
                    <td class="p-2 text-xs text-slate-600">${action.reason}</td>
                </tr>
            `;
        });
        
        html += `</tbody></table></div>`;
    });
    
    // Adiciona os ignorados (se houver)
    if (groupedByDestUnit['Ignorados']) {
        ignoreCount = groupedByDestUnit['Ignorados'].length;
    }

    DOM_IMPORT.bulkReplaceSummary.innerHTML = `
        Ações geradas: <span class="text-green-700">${updateCount} ATUALIZAÇÕES</span>, 
        <span class="text-blue-700">${createCount} NOVOS ITENS</span>, 
        <span class="text-red-700">${deleteCount} EXCLUSÕES</span>, 
        <span class="text-gray-700">${ignoreCount} IGNORADOS</span>.
        <br>Revise cuidadosamente a coluna **Ação** e **Motivo/Impacto** antes de confirmar.
    `;
    container.innerHTML = html;
    
    // Habilita o botão de confirmação final (Passo 6)
    DOM_IMPORT.confirmBulkReplaceBtn.disabled = !(updateCount + createCount + deleteCount > 0);
}

/**
 * Passo 6: Confirma as ações e executa o commit.
 */
async function confirmBulkReplace(reloadDataCallback) {
    if (!DOM_IMPORT.bulkReplaceConfirmCheckbox.checked) {
        return showNotification('Você deve marcar a caixa de confirmação para executar esta ação.', 'warning');
    }
    
    const { previewActions } = bulkReplaceState;
    if (previewActions.length === 0) return;

    const actionsToRun = previewActions.filter(a => a.action !== 'IGNORE');
    if (actionsToRun.length === 0) return showNotification('Nenhuma ação (Criar, Atualizar, Excluir) foi gerada.', 'info');

    showOverlay(`Executando ${actionsToRun.length} ações em lote...`);
    
    const batch = writeBatch(db);
    const newItemsForCache = [];
    const itemsToDeleteFromCache = [];

    actionsToRun.forEach(action => {
        const docRef = action.system ? doc(db, 'patrimonio', action.system.id) : doc(collection(db, 'patrimonio'));
        
        if (action.action === 'UPDATE') {
            const pasted = action.pasted;
            const system = action.system;
            
            const changes = {
                // Colunas pedidas pelo usuário: Tipo, Tombamento, Descrição, Quantidade, Localização, Estado, Origem da Doação, Observação, Fornecedor
                Tipo: pasted.tipo || action.systemTypeDestino || system.Tipo,
                Tombamento: normalizeTombo(pasted.tombamento || pasted.tombo),
                Descrição: pasted.descricao || pasted.item || system.Descrição,
                Unidade: action.systemUnitDestino, // Garante que está na unidade correta
                Quantidade: parseInt(pasted.quantidade, 10) || 1,
                Localização: pasted.localizacao || pasted.local || system.Localização || '',
                Estado: normalizeEstadoConservacao(pasted['estado de conservacao'] || pasted.estado || system.Estado),
                'Origem da Doação': extractOrigemDoacao(pasted) || system['Origem da Doação'] || '',
                Observação: pasted.observacao || pasted.obs || system.Observação || '[Atualizado via Substituição em Massa]',
                Fornecedor: pasted.fornecedor || system.Fornecedor || '',
                
                // Campos de auditoria
                updatedAt: serverT(),
                etiquetaPendente: true 
            };
            batch.update(docRef, changes);
            
        } else if (action.action === 'CREATE') {
            const pasted = action.pasted;
            const tombo = normalizeTombo(pasted.tombamento || pasted.tombo);

            const newItem = {
                id: docRef.id,
                Tipo: pasted.tipo || action.systemTypeDestino,
                Tombamento: tombo,
                Descrição: pasted.descricao || pasted.item || 'Item sem descrição',
                Unidade: action.systemUnitDestino, // Cria na unidade de destino
                Quantidade: parseInt(pasted.quantidade, 10) || 1,
                Localização: pasted.localizacao || pasted.local || '',
                Estado: normalizeEstadoConservacao(pasted['estado de conservacao'] || pasted.estado || 'Regular'),
                'Origem da Doação': extractOrigemDoacao(pasted) || '',
                Observação: pasted.observacao || pasted.obs || '[Criado via Substituição em Massa]',
                Fornecedor: pasted.fornecedor || '',
                
                etiquetaPendente: true,
                isPermuta: false,
                createdAt: serverT(),
                updatedAt: serverT()
            };
            batch.set(docRef, newItem);
            newItemsForCache.push(newItem);
            
        } else if (action.action === 'DELETE') {
            batch.delete(docRef);
            itemsToDeleteFromCache.push(docRef.id);
        }
    });

    try {
        await batch.commit();
        
        if (newItemsForCache.length > 0) await idb.patrimonio.bulkAdd(newItemsForCache);
        if (itemsToDeleteFromCache.length > 0) await idb.patrimonio.bulkDelete(itemsToDeleteFromCache);
        
        await idb.metadata.clear(); 
        
        showNotification(`${actionsToRun.length} ações de substituição em massa concluídas! Recarregando...`, 'success');
        
        // Reseta a UI da aba
        DOM_IMPORT.bulkReplaceResults.classList.add('hidden');
        DOM_IMPORT.bulkReplaceData.value = '';
        DOM_IMPORT.bulkReplaceTipo.value = '';
        
        // Força o recarregamento do estado global
        reloadDataCallback(true); 
        
    } catch (error) {
        hideOverlay();
        showNotification('Erro ao salvar as ações de substituição em massa.', 'error');
        console.error('Erro ao processar ações em lote:', error);
    }
}


// --- LISTENERS ---

export function setupImportacaoListeners(reloadDataCallback) {
    // 1. Setup para selects de unidade
    setupUnitSelect(DOM_IMPORT.massTransferTipo, DOM_IMPORT.massTransferUnit);
    setupUnitSelect(DOM_IMPORT.importTipo, DOM_IMPORT.importUnit); 
    setupUnitSelect(DOM_IMPORT.bulkReplaceTipo, null); // NOVO

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
            // Verifica se o Tombo já existe no inventário GERAL
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
                etiquetaPendente: true, // Novos itens criados com tombo da planilha devem ter etiqueta pendente
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
        
        // Listener para a escolha de descrição (REQUISITO 1)
        if (e.target.classList.contains('desc-choice-action')) {
            // Não precisa de lógica aqui, o valor será lido no botão de Confirmação
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

    // ETAPA 2: Clique em "Confirmar e Atualizar Itens"
    DOM_IMPORT.confirmEditByDescBtn.addEventListener('click', async () => {
        const actionSelects = DOM_IMPORT.editByDescPreviewTableContainer.querySelectorAll('select.edit-by-desc-action');
        const itemsToUpdate = [];
        const itemsToCreate = [];
        const { comparisonData } = importData;
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
            const { pastedItem, bestMatch } = comparisonData[rowIndex];
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
                    Fornecedor: pastedItem.fornecedor || '', 
                    NF: pastedItem.nf || '', 
                    'Origem da Doação': origemDoacao,
                    Estado: estadoNormalizado,
                    Quantidade: 1, 
                    Observação: `[Criado via Importação - Sobrando]. Tombo: ${pastedTombo}.`,
                    isPermuta: false,
                    etiquetaPendente: true, // Novo item com tombo da planilha deve ter etiqueta pendente
                    createdAt: serverT(), 
                    updatedAt: serverT()
                };
                itemsToCreate.push({ docRef, data: newItem });
                
            } else if (action === 'update') {
                if (systemId && pastedItem && bestMatch) {
                    updateCount++;
                    const changes = { updatedAt: serverT() };
                    let obs = bestMatch.Observação || '';
                    
                    // LÊ A ESCOLHA DE DESCRIÇÃO (REQUISITO 1)
                    // Verifica se a escolha de descrição foi feita pelo select normal ou pelo campo hidden da Ligação Manual
                    let descAction;
                    const descSelect = row.querySelector('.desc-choice-action');
                    const manualChoice = row.querySelector('.manual-desc-choice');
                    
                    if (manualChoice) {
                        descAction = manualChoice.value;
                    } else if (descSelect) {
                        descAction = descSelect.value;
                    } else {
                        descAction = 'use_system'; // Padrão de segurança
                    }
                    
                    // Verifica se o item NO SISTEMA era S/T (melhor forma de identificar a Ligação Manual)
                    const wasStItem = normalizeTombo(bestMatch.Tombamento) === 's/t' || !bestMatch.Tombamento;
                    
                    // LÓGICA DE ATUALIZAÇÃO:
                    
                    // 1. Campos base da Planilha (SEMPRE para ligar S/T ou corrigir Tombo)
                    changes.Tombamento = normalizeTombo(pastedItem.tombamento || pastedItem.tombo);
                    changes.Localização = pastedItem.local || pastedItem.localizacao || '';
                    changes.Estado = normalizeEstadoConservacao(pastedItem['estado de conservacao'] || pastedItem.estado || 'Regular');
                    changes['Origem da Doação'] = extractOrigemDoacao(pastedItem);
                    changes.Observação = pastedItem.observacao || pastedItem.obs || '';
                    changes.Fornecedor = pastedItem.fornecedor || '';
                    changes.NF = pastedItem.nf || '';
                    
                    // 2. Aplica a escolha de descrição (REQUISITO 1)
                    if (descAction === 'use_giap') {
                        changes.Descrição = pastedItem.descricao || pastedItem.item || 'S/D';
                    } else {
                        // Mantém a descrição do sistema original (bestMatch.Descrição)
                        changes.Descrição = bestMatch.Descrição;
                    }

                    const auditMsg = wasStItem ? '[Ligação S/T Manual Concluída]' : (normalizeTombo(bestMatch.Tombamento) !== changes.Tombamento ? '[Tombo Corrigido e Atualizado]' : '[Atualizado via Importação]');
                    changes.Observação = `${auditMsg} ` + (changes.Observação || obs);
                    
                    // 3. Garantir que o Tombamento NUNCA SEJA VAZIO e atualizar etiquetaPendente
                    if (!changes.Tombamento || normalizeTombo(changes.Tombamento) === 's/t') {
                        changes.Tombamento = bestMatch.Tombamento; 
                        showNotification(`Tombo do item ${bestMatch.id} não pôde ser atualizado (vazio). Mantido o original.`, 'warning', 5000);
                        changes.etiquetaPendente = false;
                    } else {
                         // Se o Tombo mudou (inclusive de S/T para número), marca etiquetaPendente.
                         if (normalizeTombo(bestMatch.Tombamento) !== changes.Tombamento) {
                             changes.etiquetaPendente = true; 
                         } else {
                             // Se o Tombo não mudou, remove a pendência.
                             changes.etiquetaPendente = false; 
                         }
                    }

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
    
    // --- (NOVO) Listeners para "Substituir Unidades em Massa" ---
    
    // Passo 3: Botão "Identificar Unidades e Mapear"
    DOM_IMPORT.previewBulkReplaceBtn.addEventListener('click', previewBulkReplace);
    
    // Passo 4: Botão "Gerar Ações de Sincronização" (Usa delegação de evento)
    DOM_IMPORT.bulkReplaceResults.addEventListener('click', (e) => {
        if (e.target.id === 'generate-bulk-actions-btn') {
            generateBulkReplaceActions();
        }
    });

    // Passo 6: Botão "Confirmar Ações em Lote"
    DOM_IMPORT.confirmBulkReplaceBtn.addEventListener('click', () => confirmBulkReplace(reloadDataCallback));
}
