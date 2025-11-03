/**
 * /src/admin/tabLigarUnidades.js
 * Lógica da aba "Ligar Unidades" (content-unidades).
 */

import { db, doc, setDoc, updateDoc, deleteField } from '../services/firebase.js';
import { getState, setState } from '../state/globalStore.js';
import { showNotification, showOverlay, hideOverlay, normalizeStr, debounce, escapeHtml } from '../utils/helpers.js';

const DOM_MAP = {
    mapFilterTipo: document.getElementById('map-filter-tipo'),
    mapSystemUnitSelect: document.getElementById('map-system-unit-select'),
    mapGiapFilter: document.getElementById('map-giap-filter'),
    mapGiapUnitMultiselect: document.getElementById('map-giap-unit-multiselect'),
    saveMappingBtn: document.getElementById('save-mapping-btn'),
    savedMappingsContainer: document.getElementById('saved-mappings-container'),
};

// --- FUNÇÕES DE RENDERIZAÇÃO E ATUALIZAÇÃO ---

/**
 * Popula a aba "Ligar Unidades" com os dados do sistema e GIAP.
 */
export function populateUnitMappingTab() {
    const { patrimonioFullList } = getState();

    // Popula Tipos do Sistema
    const tiposMap = new Map();
    patrimonioFullList.map(i => i.Tipo).filter(Boolean).forEach(tipo => {
        const normalized = normalizeStr(tipo);
        if (!tiposMap.has(normalized)) {
            tiposMap.set(normalized, tipo.trim());
        }
    });
    const tipos = [...tiposMap.values()].sort();
    DOM_MAP.mapFilterTipo.innerHTML = '<option value="">Todos os Tipos</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    
    // Chama as funções de população
    updateSystemUnitOptions();
    updateGiapUnitOptions();
    renderSavedMappings();
}

/**
 * Popula a lista de Unidades do Sistema, filtrando as já mapeadas.
 */
function updateSystemUnitOptions() {
    const { patrimonioFullList, unitMapping, normalizedSystemUnits } = getState();
    
    // --- CORREÇÃO (Início) ---
    // Adiciona uma trava de segurança para o caso da aba ser aberta antes dos dados carregarem
    if (!normalizedSystemUnits) {
        console.warn("updateSystemUnitOptions chamada antes do estado 'normalizedSystemUnits' estar pronto.");
        DOM_MAP.mapSystemUnitSelect.innerHTML = '<option>Carregando dados...</option>';
        return; 
    }
    // --- CORREÇÃO (Fim) ---

    const selectedType = DOM_MAP.mapFilterTipo.value;
    const linkedSystemUnits = Object.keys(unitMapping);
    
    // Pega todos os nomes de Tipos normalizados
    const normalizedTipos = new Set(patrimonioFullList.map(item => normalizeStr(item.Tipo)).filter(Boolean));

    const systemUnits = [...normalizedSystemUnits.values()].filter(unit => {
        // Filtra unidades cujo nome é também um nome de tipo (ex: "SEDE")
        if (normalizedTipos.has(normalizeStr(unit))) {
            return false; 
        }
        
        const item = patrimonioFullList.find(i => i.Unidade === unit);
        const isCorrectType = !selectedType || (item && normalizeStr(item.Tipo) === normalizeStr(selectedType));
        // Mostra apenas unidades que não estão mapeadas
        return isCorrectType && !linkedSystemUnits.includes(unit);
    }).sort();
    
    DOM_MAP.mapSystemUnitSelect.innerHTML = systemUnits.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
}

/**
 * Popula a lista de Unidades GIAP, com sugestões e filtrando já mapeadas.
 */
function updateGiapUnitOptions() {
    const { giapInventory, customGiapUnits, unitMapping } = getState();
    const filterText = normalizeStr(DOM_MAP.mapGiapFilter.value);
    
    let allGiapUnitsFromSheet = [...new Set(giapInventory.map(i => i.Unidade).filter(Boolean))];
    let allGiapUnits = [...new Set([...allGiapUnitsFromSheet, ...customGiapUnits.map(u => u.name)])].sort();

    const selectedSystemUnits = Array.from(DOM_MAP.mapSystemUnitSelect.selectedOptions).map(opt => opt.value);
    
    const allLinkedGiapUnits = new Set(Object.values(unitMapping).flat());
    const currentMapping = new Set();
    selectedSystemUnits.forEach(unit => {
        if (unitMapping[unit]) {
            unitMapping[unit].forEach(giapUnit => currentMapping.add(giapUnit));
        }
    });

    if (filterText) {
        allGiapUnits = allGiapUnits.filter(unit => normalizeStr(unit).includes(filterText));
    }

    const keywords = new Set();
    selectedSystemUnits.forEach(unit => {
        unit.split('/').forEach(part => keywords.add(normalizeStr(part.trim())));
    });

    const suggestions = [];
    const available = [];
    const usedByOthers = [];
    
    allGiapUnits.forEach(unit => {
        const optionHtml = `<option value="${escapeHtml(unit)}">${escapeHtml(unit)}</option>`;
        const isSuggestion = keywords.size > 0 && Array.from(keywords).some(kw => kw && normalizeStr(unit).includes(kw));

        // Unidade está disponível se não estiver em NENHUM mapeamento OU se estiver no mapeamento ATUAL
        if (!allLinkedGiapUnits.has(unit) || currentMapping.has(unit)) {
            if (isSuggestion && !filterText) {
                suggestions.push(optionHtml);
            } else {
                available.push(optionHtml);
            }
        } else {
            usedByOthers.push(optionHtml);
        }
    });

    const suggestionHeader = suggestions.length > 0 ? `<optgroup label="Sugestões">` : '';
    const suggestionFooter = suggestions.length > 0 ? `</optgroup>` : '';
    const usedHeader = usedByOthers.length > 0 ? `<optgroup label="Já Mapeadas (em outras unidades)">` : '';
    const usedFooter = usedByOthers.length > 0 ? `</optgroup>` : '';

    DOM_MAP.mapGiapUnitMultiselect.innerHTML = suggestionHeader + suggestions.join('') + suggestionFooter + available.join('') + usedHeader + usedByOthers.join('') + usedFooter;
}

/**
 * Renderiza a lista de mapeamentos salvos.
 */
function renderSavedMappings() {
    const { unitMapping } = getState();
    DOM_MAP.savedMappingsContainer.innerHTML = Object.entries(unitMapping || {}).map(([systemUnit, giapUnits]) => {
        if (!giapUnits || giapUnits.length === 0) return '';
        return `
            <div class="p-2 border rounded-md bg-slate-50 flex justify-between items-center">
                <div>
                    <strong class="text-blue-600">${escapeHtml(systemUnit)}</strong>
                    <span class="text-xs mx-2">➔</span>
                    <span>${giapUnits.map(u => escapeHtml(u)).join(', ')}</span>
                </div>
                <button class="delete-mapping-btn p-1 text-red-500 hover:bg-red-100 rounded-full" data-system-unit="${escapeHtml(systemUnit)}" title="Excluir Mapeamento">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11z"/></svg>
                </button>
            </div>
        `;
    }).join('');
}


// --- LISTENERS ---

export function setupLigarUnidadesListeners() {
    // Filtra unidades do sistema ao mudar o tipo
    DOM_MAP.mapFilterTipo.addEventListener('change', () => {
        updateSystemUnitOptions();
        updateGiapUnitOptions();
    });
    
    // Atualiza sugestões GIAP ao mudar seleção do sistema
    DOM_MAP.mapSystemUnitSelect.addEventListener('change', updateGiapUnitOptions);

    // Filtra unidades GIAP
    DOM_MAP.mapGiapFilter.addEventListener('input', debounce(updateGiapUnitOptions, 300));
    
    // Salvar mapeamento
    DOM_MAP.saveMappingBtn.addEventListener('click', async () => {
        const { unitMapping } = getState();
        const selectedSystemUnits = Array.from(DOM_MAP.mapSystemUnitSelect.selectedOptions).map(opt => opt.value);
        const selectedGiapUnits = Array.from(DOM_MAP.mapGiapUnitMultiselect.selectedOptions).map(opt => opt.value);

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

            // Mescla os novos mapeamentos com os existentes
            const updatedMappingData = { ...unitMapping, ...newMappings };
            
            // Usa setDoc (sem merge) para sobrescrever o campo 'mappings' inteiro
            await setDoc(mappingRef, { mappings: updatedMappingData });
            
            setState({ unitMapping: updatedMappingData });
            
            // Re-popula a aba inteira para refletir as mudanças
            populateUnitMappingTab(); 

            showNotification('Mapeamento salvo com sucesso!', 'success');
        } catch (error) {
            console.error("Erro ao salvar mapeamento:", error);
            showNotification('Erro ao salvar mapeamento.', 'error');
        } finally {
            hideOverlay();
        }
    });
    
    // Excluir mapeamento
    DOM_MAP.savedMappingsContainer.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-mapping-btn');
        if (!deleteBtn) return;

        const systemUnit = deleteBtn.dataset.systemUnit;
        if (!systemUnit) return;

        // Subistitua 'confirm' por um modal customizado se a aplicação final for ser publicada
        if (!confirm(`Tem certeza que deseja excluir o mapeamento para "${systemUnit}"?`)) {
            return;
        }

        showOverlay('Excluindo mapeamento...');
        try {
            const mappingRef = doc(db, 'config', 'unitMapping');
            
            const keyToDelete = `mappings.${systemUnit}`;
            await updateDoc(mappingRef, {
                [keyToDelete]: deleteField() // Exclui o campo do documento
            });

            const currentMapping = { ...getState().unitMapping };
            delete currentMapping[systemUnit];
            setState({ unitMapping: currentMapping });
            
            // Re-popula a aba inteira
            populateUnitMappingTab(); 

            showNotification('Mapeamento excluído!', 'success');
        } catch (error) {
            console.error("Erro ao excluir mapeamento:", error);
            showNotification('Erro ao excluir mapeamento.', 'error');
        } finally {
            hideOverlay();
        }
    });
}
