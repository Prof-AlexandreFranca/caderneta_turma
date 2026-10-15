// ==========================================
// 1. CONFIGURAÇÕES PÚBLICAS DO CLIENTE
// ==========================================
// A chave Gemini NÃO fica neste arquivo. A chamada passa pelo Worker.
const GEMINI_WORKER_URL = "https://carteira-gemini.aleofranca.workers.dev";
const ALLOWED_FIREBASE_UID = "rgWrsocucgVEqFn6TVHFUFt6hz32";

const firebaseConfig = {
  apiKey: "AIzaSyBunP6TZo7aZMSnCBUOBV3YHwdUpVw6pjM",
  authDomain: "cadernetaturmas.firebaseapp.com",
  databaseURL: "https://cadernetaturmas-default-rtdb.firebaseio.com",
  projectId: "cadernetaturmas",
  storageBucket: "cadernetaturmas.firebasestorage.app",
  messagingSenderId: "456032739473",
  appId: "1:456032739473:web:6eb8dbb0864d1fb1511f30",
  measurementId: "G-LYJM0YYT53"
};

// ==========================================
// 2. INICIALIZAÇÃO FIREBASE & ESTADO (STATE)
// ==========================================
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

let state = {
    classes: {},
    currentClassId: null
};

const storageKey = "caderneta_pro_state_MEU";
let geminiAvailableModels = null;

// --- FUNÇÕES UTILITÁRIAS DO SEU CÓDIGO ---
function parseStudentName(alunoRaw) {
    alunoRaw = String(alunoRaw || '').trim();
    const match = String(alunoRaw).trim().match(/^(\d+)\s*[-º°.]?\s*(.+)\$/);
    if (match) {
        return { numero: match[1], nome: match[2].trim(), raw: alunoRaw };
    }
    return { numero: null, nome: alunoRaw.trim(), raw: alunoRaw };
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim();
}

function resolveStudentRaw(value, students) {
    const query = normalizeText(value);
    if (!query) return null;
    const exact = students.find(raw => normalizeText(raw) === query);
    if (exact) return exact;

    const queryNumber = query.match(/(?:ALUNO\s*)?(\d+)/)?.[1];
    const queryName = query.replace(/^(?:ALUNO\s*)?\d+\s*/, '').trim();
    return students.find(raw => {
        const parsed = parseStudentName(raw);
        const sameNumber = queryNumber && parsed.numero === queryNumber;
        const normalizedName = normalizeText(parsed.nome);
        const sameName = queryName && (normalizedName === queryName || normalizedName.includes(queryName) || queryName.includes(normalizedName));
        return sameNumber || sameName;
    }) || null;
}

function parseVistoValue(value) {
    if (typeof value === 'number' && [0, 0.5, 1].includes(value)) return value;
    const raw = String(value ?? '').trim();
    if (raw === '+') return 1;
    if (raw === '-') return 0;
    const text = normalizeText(value);
    if (!text) return null;
    if (['+', 'FEZ', 'SIM', 'OK', 'COMPLETO', 'CONCLUIDO', 'REALIZOU'].includes(text)) return 1;
    if (['NAO', 'NAO FEZ', 'FALTOU', 'NAO REALIZOU'].includes(text)) return 0;
    if (['PARCIAL', 'MEIO', 'MEIO VISTO', 'METADE', 'INCOMPLETO', 'PELA METADE'].includes(text)) return 0.5;
    const numeric = Number(String(value).replace(',', '.'));
    return [0, 0.5, 1].includes(numeric) ? numeric : null;
}

function getNowDateTimeLocal() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
}

function sanitizeClass(cls) {
    if (!cls) return null;
    return {
        nome: cls.nome || "Turma Sem Nome",
        alunos: Array.isArray(cls.alunos) ? cls.alunos : [],
        avaliacoes: Array.isArray(cls.avaliacoes) ? cls.avaliacoes : [],
        atividades: Array.isArray(cls.atividades) ? cls.atividades : [],
        vistos: cls.vistos || {},
        ocorrencias: Array.isArray(cls.ocorrencias) ? cls.ocorrencias : [],
        notas_manuais: cls.notas_manuais || {},
        config: cls.config || { desconto_ocorrencia: 0, desconto_ativo: false },
        updatedAt: Number(cls.updatedAt) || 0
    };
}

function notifyUser(message, type = 'success') {
    let toast = document.getElementById('appToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'appToast';
        toast.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:200;padding:12px 16px;border-radius:8px;color:#fff;font:600 14px system-ui;box-shadow:0 4px 14px rgba(0,0,0,.2);transition:opacity .2s;max-width:360px;';
        document.body.appendChild(toast);
    }
    toast.style.background = type === 'error' ? '#b91c1c' : '#047857';
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 4500);
}

// ==========================================
// SINCRONIZAÇÃO EM TEMPO REAL (FIREBASE)
// ==========================================

// Monitora o estado do login do Firebase
auth.onAuthStateChanged((user) => {
    if (user) {
        // Conectado: Ativa a escuta em tempo real no banco do Firebase
        initRealtimeSync(user.uid);
    } else {
        // Desconectado: Usa o backup local
        loadLocalFallback();
    }
});

function getDatabaseRef(uid) {
    return uid ? db.ref(`users/${uid}/turmas`) : db.ref('turmas');
}

function initRealtimeSync(uid) {
    const userRef = getDatabaseRef(uid);

    // .on('value') atualiza a tela automaticamente assim que houver alteração no PC ou Celular
    userRef.on('value', (snapshot) => {
        if (snapshot.exists()) {
            const remoteClasses = snapshot.val() || {};
            
            state.classes = {};
            Object.entries(remoteClasses).forEach(([id, cls]) => {
                state.classes[id] = sanitizeClass(cls);
            });

            // Atualiza o backup no LocalStorage do aparelho
            localStorage.setItem(storageKey, JSON.stringify(state.classes));

            // Atualiza a interface da tela
            if (typeof ui !== 'undefined') {
                ui.populateClassSelector();
                ui.renderClassListModal();
                
                if (state.currentClassId && state.classes[state.currentClassId]) {
                    app.selectClass(state.currentClassId);
                } else if (Object.keys(state.classes).length > 0) {
                    app.selectClass(Object.keys(state.classes)[0]);
                }
            }
        } else {
            loadLocalFallback();
            if (Object.keys(state.classes).length > 0) {
                userRef.set(state.classes);
            }
        }
    }, (error) => {
        console.error("Erro de permissão/conexão no Firebase:", error);
        notifyUser("Erro de sincronização com a nuvem.", "error");
        loadLocalFallback();
    });
}

function loadLocalFallback() {
    try {
        const local = localStorage.getItem(storageKey);
        state.classes = local ? JSON.parse(local) : {};
        for (let key in state.classes) {
            state.classes[key] = sanitizeClass(state.classes[key]);
        }
    } catch (e) {
        state.classes = {};
    }
    if (typeof ui !== 'undefined') {
        ui.populateClassSelector();
        ui.renderClassListModal();
        if (Object.keys(state.classes).length > 0 && !state.currentClassId) {
            app.selectClass(Object.keys(state.classes)[0]);
        }
    }
}

// Função alias caso algum botão do seu código ainda chame loadData() diretamente
function loadData() {
    if (auth.currentUser) {
        initRealtimeSync(auth.currentUser.uid);
    } else {
        loadLocalFallback();
    }
}

function saveData() {
    if (state.currentClassId && state.classes[state.currentClassId]) {
        state.classes[state.currentClassId] = {
            ...sanitizeClass(state.classes[state.currentClassId]),
            updatedAt: Date.now()
        };
    }

    // 1. Salva imediatamente no dispositivo local
    localStorage.setItem(storageKey, JSON.stringify(state.classes));

    // 2. Transmite para a nuvem no Firebase
    const user = auth.currentUser;
    if (user) {
        getDatabaseRef(user.uid).set(state.classes).catch((error) => {
            console.error("Falha ao salvar no Firebase:", error);
            notifyUser("Salvo apenas no dispositivo local.", "error");
        });
    } else {
        db.ref('turmas').set(state.classes).catch((e) => {
            console.warn("Firebase offline ou não autenticado.");
        });
    }
}

// ==========================================
// 3. UI CONTROLLER (INTERFACING & NAVEGAÇÃO)
// ==========================================
const ui = {
    init() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
                
                const targetBtn = e.currentTarget;
                targetBtn.classList.add('active');
                document.getElementById(targetBtn.dataset.target).classList.remove('hidden');
                app.refreshCurrentTab();
            });
        });
    },
    openModal(id) { 
        if(id === 'modalActivityManager' && document.getElementById('newActivityDate')) {
            document.getElementById('newActivityDate').valueAsDate = new Date();
        }
        if(id === 'modalClassManager') {
            ui.renderClassListModal();
        }
        if(id === 'modalEvals') {
            app.populateCopyEvalSourceSelector();
        }
        document.getElementById(id).classList.remove('hidden'); 
    },
    closeModal(id) { document.getElementById(id).classList.add('hidden'); },
    populateClassSelector() {
        const sel = document.getElementById('classSelector');
        sel.innerHTML = '<option value="">Selecione a Turma...</option>';
        Object.keys(state.classes).forEach(id => {
            sel.innerHTML += `<option value="${id}">${state.classes[id].nome}</option>`;
        });
        sel.onchange = (e) => app.selectClass(e.target.value);
    },
    renderClassListModal() {
        const container = document.getElementById('classListContainer');
        if(!container) return;
        let html = '';
        Object.keys(state.classes).forEach(id => {
            const cls = state.classes[id];
            html += `
            <li class="py-2 flex justify-between items-center">
                <span class="font-medium">${cls.nome} <small class="text-slate-400">(${cls.alunos.length} alunos)</small></span>
                <button onclick="app.deleteClassById('${id}')" class="text-red-500 hover:text-red-700 p-1" title="Excluir Turma">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </li>`;
        });
        container.innerHTML = html || '<p class="text-xs text-slate-400 py-2">Nenhuma turma cadastrada.</p>';
    },
    toggleEvalTargets() {
        const type = document.getElementById('evalType').value;
        const box = document.getElementById('evalTargetsBox');
        if(type === 'recuperacao') {
            box.classList.remove('hidden');
            const cls = state.classes[state.currentClassId];
            let html = '';
            if(cls && cls.avaliacoes) {
                cls.avaliacoes.forEach(a => {
                    if(a.tipo !== 'recuperacao') {
                        html += `<label class="inline-flex items-center gap-1 bg-white border px-2 py-1 rounded"><input type="checkbox" class="target-eval" value="${a.id}"> ${a.nome}</label>`;
                    }
                });
            }
            document.getElementById('evalTargetsList').innerHTML = html;
        } else {
            box.classList.add('hidden');
        }
    }
};

// ==========================================
// 4. LÓGICA PRINCIPAL (APP)
// ==========================================
const app = {
    async authenticate(e) {
        if (e) e.preventDefault();
        const email = document.getElementById('authEmail').value.trim();
        const password = document.getElementById('authPassword').value;
        const btnSubmit = document.getElementById('btnAuthSubmit');
        const errEl = document.getElementById('authErrorMsg');

        errEl.classList.add('hidden');
        btnSubmit.disabled = true;
        btnSubmit.innerText = "Entrando...";

        try {
            const credential = await auth.signInWithEmailAndPassword(email, password);
            if (credential.user.uid !== ALLOWED_FIREBASE_UID) {
                await auth.signOut();
                throw new Error("USER_NOT_ALLOWED");
            }
            document.getElementById('modalAuth').classList.add('hidden');
            notifyUser("Sessão autenticada com sucesso.");
            await loadData();
        } catch (err) {
            console.error('Falha no login Firebase:', err);
            errEl.innerText = err.message === "USER_NOT_ALLOWED"
                ? "Usuário não autorizado."
                : "E-mail ou senha inválidos.";
            errEl.classList.remove('hidden');
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.innerText = "Entrar";
        }
    },

    async checkSession() {
        const user = auth.currentUser;
        if (user && user.uid === ALLOWED_FIREBASE_UID) {
            document.getElementById('modalAuth').classList.add('hidden');
            return true;
        }
        document.getElementById('modalAuth').classList.remove('hidden');
        return false;
    },

    selectClass(id) {
        state.currentClassId = id;
        document.getElementById('classSelector').value = id || "";
        if(id && state.classes[id]) {
            let cls = state.classes[id];
            document.getElementById('occDiscountVal').value = cls.config.desconto_ocorrencia || 0.1;
            document.getElementById('occDiscountToggle').checked = cls.config.desconto_ativo;
            
            const opts = cls.alunos.map(a => `<option value="${a}">${a}</option>`).join('');
            document.getElementById('repStudent').innerHTML = '<option value="">Todos os Alunos</option>' + opts;
        } else {
            document.getElementById('repStudent').innerHTML = '<option value="">Todos os Alunos</option>';
        }
        this.refreshCurrentTab();
    },
    refreshCurrentTab() {
        if(!state.currentClassId || !state.classes[state.currentClassId]) {
            document.getElementById('tbodyActivities').innerHTML = '';
            document.getElementById('theadActivities').innerHTML = '';
            document.getElementById('tbodyOccurrences').innerHTML = '';
            document.getElementById('occListContainer').innerHTML = '<li class="text-slate-500 list-none text-center py-4">Selecione ou cadastre uma turma para começar.</li>';
            document.getElementById('tbodyGrades').innerHTML = '';
            document.getElementById('theadGrades').innerHTML = '';
            return;
        }
        this.renderAtividades();
        this.renderOcorrencias();
        this.renderEvalsList();
        this.renderNotas();
    },
    saveClass() {
        const name = document.getElementById('newClassName').value.trim();
        const studentsRaw = document.getElementById('newClassStudents').value.trim();
        if(!name) return alert("Digite o nome da turma.");
        
        const id = 'turma_' + Date.now();
        state.classes[id] = sanitizeClass({
            nome: name,
            alunos: studentsRaw.split('\n').map(s => s.trim()).filter(s => s),
            updatedAt: Date.now()
        });
        
        saveData();
        ui.populateClassSelector();
        ui.renderClassListModal();
        app.selectClass(id);
        document.getElementById('newClassName').value = '';
        document.getElementById('newClassStudents').value = '';
        ui.closeModal('modalClassManager');
    },

    openEditClassModal() {
        if(!state.currentClassId || !state.classes[state.currentClassId]) {
            return alert("Selecione uma turma para editar.");
        }
        const cls = state.classes[state.currentClassId];
        document.getElementById('editClassName').value = cls.nome;
        document.getElementById('editClassStudents').value = cls.alunos.join('\n');
        ui.openModal('modalEditClass');
    },

    updateCurrentClass() {
        if(!state.currentClassId || !state.classes[state.currentClassId]) return;
        const newName = document.getElementById('editClassName').value.trim();
        const studentsRaw = document.getElementById('editClassStudents').value.trim();
        
        if(!newName) return alert("Digite o nome da turma.");
        
        let cls = state.classes[state.currentClassId];
        cls.nome = newName;
        cls.alunos = studentsRaw.split('\n').map(s => s.trim()).filter(s => s);
        cls.updatedAt = Date.now();
        
        saveData();
        ui.populateClassSelector();
        ui.renderClassListModal();
        this.refreshCurrentTab();
        ui.closeModal('modalEditClass');
        notifyUser("Turma e lista de alunos atualizadas com sucesso!");
    },

    deleteCurrentClass() {
        if(!state.currentClassId) return alert("Selecione uma turma para excluir.");
        this.deleteClassById(state.currentClassId);
    },
    deleteClassById(id) {
        const clsName = state.classes[id] ? state.classes[id].nome : "esta turma";
        if(!confirm(`Tem certeza que deseja EXCLUIR a turma "${clsName}"? Esta ação excluirá permanentemente notas, vistos e ocorrências!`)) return;
        
        delete state.classes[id];
        try {
            db.ref(`turmas/${id}`).remove();
        } catch(e){}
        
        saveData();
        ui.populateClassSelector();
        ui.renderClassListModal();
        
        const remainingKeys = Object.keys(state.classes);
        if(remainingKeys.length > 0) {
            app.selectClass(remainingKeys[0]);
        } else {
            app.selectClass(null);
        }
    },

    // --- MÓDULO DE VISTOS ---
    saveActivity() {
        const name = document.getElementById('newActivityName').value.trim();
        const dateInput = document.getElementById('newActivityDate').value;
        if(!name || !state.currentClassId) return;
        
        let formattedDate = "";
        if(dateInput) {
            const parts = dateInput.split('-');
            formattedDate = `${parts[2]}/${parts[1]}`;
        }

        let cls = state.classes[state.currentClassId];
        cls.atividades.push({ 
            id: 'ativ_'+Date.now(), 
            nome: name,
            data: formattedDate
        });
        
        saveData();
        this.refreshCurrentTab();
        document.getElementById('newActivityName').value = '';
        ui.closeModal('modalActivityManager');
    },
    deleteActivity(id) {
        if(!confirm("Excluir atividade? Os vistos correspondentes também serão removidos.")) return;
        let cls = state.classes[state.currentClassId];
        cls.atividades = cls.atividades.filter(a => a.id !== id);
        saveData();
        this.refreshCurrentTab();
    },
    setVisto(aluno, ativId, valor) {
        let cls = state.classes[state.currentClassId];
        if(!cls.vistos[aluno]) cls.vistos[aluno] = {};
        cls.vistos[aluno][ativId] = valor;
        saveData();
        this.renderAtividades();
        this.renderNotas();
    },
    renderAtividades() {
        const cls = state.classes[state.currentClassId];
        const thead = document.getElementById('theadActivities');
        const tbody = document.getElementById('tbodyActivities');
        const editList = document.getElementById('listEditActivities');
        
        if(!cls) return;
        
        let thHtml = `<th class="p-3 font-semibold text-slate-600">Aluno</th>`;
        let editHtml = '';
        cls.atividades.forEach(a => {
            let dataStr = a.data ? `<span class="text-xs text-slate-400 font-normal block">${a.data}</span>` : '';
            thHtml += `<th class="p-3 font-semibold text-slate-600 text-center min-w-[140px]"><div class="flex items-center justify-center gap-2"><span>${a.nome}${dataStr}</span><button class="no-print text-red-500 hover:text-red-700" onclick="app.deleteActivity('${a.id}')" title="Excluir atividade"><i class="fa-solid fa-trash"></i></button></div></th>`;
            editHtml += `<li class="py-2 flex justify-between items-center"><span>${a.nome} ${a.data ? `(\${a.data})` : ''}</span> <button onclick="app.deleteActivity('${a.id}')" class="text-red-500"><i class="fa-solid fa-trash"></i></button></li>`;
        });
        thead.innerHTML = thHtml;
        editList.innerHTML = editHtml;

        let tbHtml = '';
        cls.alunos.forEach(alunoRaw => {
            const parsed = parseStudentName(alunoRaw);
            let displayAluno = parsed.numero 
                ? `<span class="inline-block bg-slate-200 text-slate-700 font-bold px-2 py-0.5 rounded mr-2 text-xs">${parsed.numero}</span>${parsed.nome}`
                : parsed.nome;

            tbHtml += `<tr><td class="p-3 border-b font-medium">${displayAluno}</td>`;
            cls.atividades.forEach(a => {
                let v = (cls.vistos[alunoRaw] && cls.vistos[alunoRaw][a.id]) !== undefined ? cls.vistos[alunoRaw][a.id] : 0;
                tbHtml += `<td class="p-3 border-b text-center">
                    <div class="flex gap-1 justify-center">
                        <button onclick="app.setVisto('${alunoRaw}','${a.id}',1)" class="btn-visto ${v===1?'active':''}" title="Visto Completo (+)"><i class="fa-solid fa-plus"></i></button>
                        <button onclick="app.setVisto('${alunoRaw}','${a.id}',0.5)" class="btn-visto ${v===0.5?'active':''}" title="Meio Visto (½)">½</button>
                        <button onclick="app.setVisto('${alunoRaw}','${a.id}',0)" class="btn-visto ${v===0?'active':''}" title="Sem Visto (-)"><i class="fa-solid fa-minus"></i></button>
                    </div>
                </td>`;
            });
            cls.avaliacoes.filter(a => a.tipo === 'atividades').forEach(aval => {
                const nota = this.calcAlunoNotas(cls, alunoRaw).detalhe[aval.id] ?? 0;
                tbHtml += `<td class="p-3 border-b text-center font-semibold text-blue-700 bg-blue-50">${Number(nota).toFixed(2)}</td>`;
            });
            tbHtml += `</tr>`;
        });
        cls.avaliacoes.filter(a => a.tipo === 'atividades').forEach(aval => {
            thHtml += `<th class="p-3 font-semibold text-blue-700 text-center min-w-[130px] bg-blue-50">${aval.nome}<span class="text-xs block">(${Number(aval.valorMax).toFixed(1)} pts)</span></th>`;
        });
        thead.innerHTML = thHtml;
        tbody.innerHTML = tbHtml;
    },

    printActivities() {
        const cls = state.classes[state.currentClassId];
        if (!cls) return alert('Selecione uma turma primeiro.');
        
        let styleEl = document.getElementById('dynamic-print-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-print-style';
            document.head.appendChild(styleEl);
        }

        const totalAlunos = cls.alunos.length;
        const fontSize = totalAlunos > 30 ? '6.5pt' : totalAlunos > 20 ? '7.5pt' : '8.5pt';
        const cellPadding = totalAlunos > 30 ? '1px 2px' : totalAlunos > 20 ? '2px 3px' : '3px 4px';

        styleEl.innerHTML = `
            @media print {
                @page {
                    size: A4 landscape;
                    margin: 5mm;
                }
                html, body {
                    height: 100vh !important;
                    max-height: 100vh !important;
                    overflow: hidden !important;
                    margin: 0 !important;
                    padding: 0 !important;
                }
                #printArea {
                    display: block !important;
                    position: absolute !important;
                    left: 0 !important;
                    top: 0 !important;
                    width: 100% !important;
                    height: 100vh !important;
                    max-height: 100vh !important;
                    overflow: hidden !important;
                    box-sizing: border-box !important;
                    background: #fff !important;
                    padding: 4mm !important;
                }
                .print-activities-container {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                }
                .print-activities-table {
                    width: 100% !important;
                    border-collapse: collapse !important;
                    font-size: ${fontSize} !important;
                    table-layout: auto;
                }
                .print-activities-table th,
                .print-activities-table td {
                    padding: ${cellPadding} !important;
                    line-height: 1.1 !important;
                    border: 1px solid #333 !important;
                    text-align: center !important;
                }
                .print-activities-table th:first-child,
                .print-activities-table td:first-child {
                    text-align: left !important;
                    white-space: nowrap !important;
                }
                tr {
                    page-break-inside: avoid !important;
                    break-inside: avoid !important;
                }
            }
        `;

        let html = `<div class="print-activities-container">
            <h1 style="font-size: 15px; font-weight: bold; margin-bottom: 2px;">Controle de Vistos</h1>
            <p style="font-size: 11px; margin-bottom: 6px;"><strong>Turma:</strong> ${cls.nome}</p>
            <table class="print-table print-activities-table"><thead><tr><th>Aluno</th>`;
        cls.atividades.forEach(a => { html += `<th>${a.nome}${a.data ? `<br><small>\${a.data}</small>` : ''}</th>`; });
        cls.avaliacoes.filter(a => a.tipo === 'atividades').forEach(a => { html += `<th>${a.nome}<br><small>${a.valorMax} pts</small></th>`; });
        html += '</tr></thead><tbody>';
        cls.alunos.forEach(aluno => {
            const p = parseStudentName(aluno);
            const nomeExibicao = p.numero ? `${p.numero} - ${p.nome}` : p.nome;
            html += `<tr><td>${nomeExibicao}</td>`;
            cls.atividades.forEach(a => {
                const value = cls.vistos[aluno]?.[a.id];
                html += `<td>${value === 1 ? '+' : value === 0.5 ? '½' : value === 0 ? '-' : ''}</td>`;
            });
            cls.avaliacoes.filter(a => a.tipo === 'atividades').forEach(a => {
                html += `<td>${Number(this.calcAlunoNotas(cls, aluno).detalhe[a.id] || 0).toFixed(2)}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        document.getElementById('printArea').innerHTML = html;
        window.print();
        setTimeout(() => {
            document.getElementById('printArea').innerHTML = '';
            if (styleEl) styleEl.innerHTML = '';
        }, 1000);
    },

    // --- MÓDULO DE OCORRÊNCIAS ---
    toggleDiscount() {
        let cls = state.classes[state.currentClassId];
        cls.config.desconto_ativo = document.getElementById('occDiscountToggle').checked;
        cls.config.desconto_ocorrencia = parseFloat(document.getElementById('occDiscountVal').value) || 0;
        saveData();
        this.renderNotas();
        this.renderOcorrencias();
    },
    delOccurrence(id) {
        if(!confirm("Deletar registro de ocorrência?")) return;
        let cls = state.classes[state.currentClassId];
        cls.ocorrencias = cls.ocorrencias.filter(o => o.id !== id);
        saveData();
        this.refreshCurrentTab();
    },
    renderOcorrencias() {
        let cls = state.classes[state.currentClassId];
        if(!cls) return;

        let compAval = cls.avaliacoes.find(a => a.tipo === 'comportamento');
        let maxComp = compAval ? compAval.valorMax : 10;
        let desconto = cls.config.desconto_ativo ? (cls.config.desconto_ocorrencia || 0) : 0;

        let tbody = '';
        cls.alunos.forEach(alunoRaw => {
            const parsed = parseStudentName(alunoRaw);
            let num = parsed.numero || '-';
            
            let ocorrenciasAluno = cls.ocorrencias.filter(o => o.aluno === alunoRaw);
            let count = ocorrenciasAluno.length;
            let perda = count * desconto;
            let notaComp = maxComp - perda;
            if(notaComp < 0) notaComp = 0;

            tbody += `
                <tr class="hover:bg-slate-50">
                    <td class="p-3 text-center border-b border-r text-slate-500">${num}</td>
                    <td class="p-3 border-b border-r font-medium">${parsed.nome}</td>
                    <td class="p-3 text-center border-b border-r">${count}</td>
                    <td class="p-3 text-center border-b border-r text-red-500">${perda > 0 ? '-' + perda.toFixed(2) : '0.00'}</td>
                    <td class="p-3 text-center border-b font-bold">${notaComp.toFixed(2)}</td>
                </tr>
            `;
        });
        document.getElementById('tbodyOccurrences').innerHTML = tbody || '<tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhum aluno cadastrado.</td></tr>';

        let historyHtml = '';
        let ocorrenciasRev = [...cls.ocorrencias].reverse();
        ocorrenciasRev.forEach(o => {
            const parsed = parseStudentName(o.aluno);
            let dataHoraFmt = "Data N/I";
            if(o.dataHora) {
                const [d, t] = o.dataHora.split('T');
                dataHoraFmt = `${d.split('-').reverse().join('/')}, ${t}`;
            } else if(o.data) {
                dataHoraFmt = o.data.split('-').reverse().join('/');
            }

            historyHtml += `
            <li class="group flex items-start justify-between py-1 border-b border-slate-100 last:border-0">
                <span class="text-slate-700"><strong>[${dataHoraFmt}]</strong> ${parsed.nome}: ${o.desc}</span>
                <button onclick="app.delOccurrence('${o.id}')" class="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity ml-2" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </li>`;
        });
        document.getElementById('occListContainer').innerHTML = historyHtml || '<li class="text-slate-500 list-none">Nenhuma ocorrência registrada nesta turma.</li>';
    },
    generateReport() {
        let cls = state.classes[state.currentClassId];
        const student = document.getElementById('repStudent').value;
        const dStart = document.getElementById('repDateStart').value;
        const dEnd = document.getElementById('repDateEnd').value;
        
        let filtered = cls.ocorrencias;
        if(student) filtered = filtered.filter(o => o.aluno === student);
        if(dStart) filtered = filtered.filter(o => (o.dataHora || o.data) >= dStart);
        if(dEnd) filtered = filtered.filter(o => (o.dataHora || o.data) <= dEnd + "T23:59");
        
        let printHtml = `
            <h1 style="font-size: 22px; font-weight: bold; margin-bottom: 8px;">Relatório Disciplinar</h1>
            <p><strong>Turma:</strong> ${cls.nome}</p>
            <p><strong>Aluno:</strong> ${student || 'Todos os Alunos'} | <strong>Período:</strong> ${dStart||'Início'} até ${dEnd||'Hoje'}</p>
            <table class="print-table" style="width:100%; margin-top:15px; border-collapse:collapse;">
                <thead><tr style="background:#f1f5f9;"><th style="border:1px solid #ccc; padding:6px;">Data/Hora</th><th style="border:1px solid #ccc; padding:6px;">Aluno</th><th style="border:1px solid #ccc; padding:6px;">Infração</th></tr></thead>
                <tbody>
        `;
        filtered.forEach(o => {
            let dh = o.dataHora ? o.dataHora.replace('T', ' ') : o.data;
            printHtml += `<tr><td style="border:1px solid #ccc; padding:6px;">${dh}</td><td style="border:1px solid #ccc; padding:6px;">${o.aluno}</td><td style="border:1px solid #ccc; padding:6px;">${o.desc}</td></tr>`;
        });
        printHtml += `</tbody></table>`;
        
        document.getElementById('printArea').innerHTML = printHtml;
        ui.closeModal('modalReport');
        window.print();
        setTimeout(() => document.getElementById('printArea').innerHTML = '', 1000);
    },

    // --- MÓDULO DE NOTAS & MODELOS DE AVALIAÇÃO ---
    saveEval() {
        const nome = document.getElementById('evalName').value.trim();
        const tipo = document.getElementById('evalType').value;
        const max = parseFloat(document.getElementById('evalMax').value) || 0;
        if(!nome || max <= 0) return alert("Preencha o nome e um valor máximo válido.");
        
        let targets = [];
        if(tipo === 'recuperacao') {
            document.querySelectorAll('.target-eval:checked').forEach(cb => targets.push(cb.value));
            if(targets.length === 0) return alert("Selecione pelo menos uma avaliação para a recuperação substituir.");
        }
        
        let cls = state.classes[state.currentClassId];
        cls.avaliacoes.push({ id: 'aval_'+Date.now(), nome, tipo, valorMax: max, targets });
        saveData();
        this.renderEvalsList();
        this.refreshCurrentTab();
        document.getElementById('evalName').value = '';
    },
    delEval(id) {
        if(!confirm("Remover esta avaliação do quadro?")) return;
        let cls = state.classes[state.currentClassId];
        cls.avaliacoes = cls.avaliacoes.filter(a => a.id !== id);
        saveData();
        this.renderEvalsList();
        this.refreshCurrentTab();
    },
    renderEvalsList() {
        let cls = state.classes[state.currentClassId];
        if(!cls) return;
        let html = '';
        cls.avaliacoes.forEach(a => {
            html += `<tr class="border-b"><td class="p-1">${a.nome}</td><td class="p-1 text-xs capitalize">${a.tipo}</td><td class="p-1">${a.valorMax}</td><td class="p-1 text-right"><button onclick="app.delEval('${a.id}')" class="text-red-500"><i class="fa-solid fa-trash"></i></button></td></tr>`;
        });
        document.getElementById('evalsListTbody').innerHTML = html;
        ui.toggleEvalTargets();
    },

    populateCopyEvalSourceSelector() {
        const sel = document.getElementById('copyEvalSourceClass');
        if(!sel) return;
        sel.innerHTML = '<option value="">Copiar de qual turma?...</option>';
        Object.keys(state.classes).forEach(id => {
            if(id !== state.currentClassId) {
                sel.innerHTML += `<option value="${id}">${state.classes[id].nome}</option>`;
            }
        });
    },

    copyEvalsFromOtherClass() {
        if(!state.currentClassId) return alert("Selecione uma turma primeiro.");
        const sourceId = document.getElementById('copyEvalSourceClass').value;
        if(!sourceId || !state.classes[sourceId]) return alert("Selecione a turma de origem das avaliações.");

        const sourceEvals = state.classes[sourceId].avaliacoes || [];
        if(sourceEvals.length === 0) return alert("A turma selecionada não possui nenhuma avaliação configurada.");

        let targetCls = state.classes[state.currentClassId];
        if(targetCls.avaliacoes.length > 0) {
            if(!confirm("Esta turma já possui avaliações. Deseja ADICIONAR as avaliações da outra turma à lista atual?")) return;
        }

        const idMapping = {};
        sourceEvals.forEach(a => {
            const newId = 'aval_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            idMapping[a.id] = newId;
        });

        sourceEvals.forEach(a => {
            let newTargets = [];
            if(a.targets && Array.isArray(a.targets)) {
                newTargets = a.targets.map(oldId => idMapping[oldId] || oldId);
            }
            targetCls.avaliacoes.push({
                id: idMapping[a.id],
                nome: a.nome,
                tipo: a.tipo,
                valorMax: a.valorMax,
                targets: newTargets
            });
        });

        saveData();
        this.renderEvalsList();
        this.refreshCurrentTab();
        notifyUser(`${sourceEvals.length} avaliação(ões) copiada(s) com sucesso!`);
    },

    updateManualNota(aluno, avalId, input) {
        let val = parseFloat(input.value);
        let cls = state.classes[state.currentClassId];
        if(!cls.notas_manuais[aluno]) cls.notas_manuais[aluno] = {};
        if(isNaN(val)) {
            delete cls.notas_manuais[aluno][avalId];
        } else {
            cls.notas_manuais[aluno][avalId] = val;
        }
        saveData();
        this.renderNotas();
    },
    calcAlunoNotas(cls, aluno) {
        let notas_calculadas = {};
        let notas_para_soma = {};
        
        cls.avaliacoes.forEach(aval => {
            if(aval.tipo === 'recuperacao') return;
            
            let nota = 0;
            if(aval.tipo === 'manual') {
                nota = (cls.notas_manuais[aluno] && cls.notas_manuais[aluno][aval.id]) || 0;
            } 
            else if(aval.tipo === 'atividades') {
                let totalVistosPossiveis = cls.atividades.length;
                if(totalVistosPossiveis > 0) {
                    let pesoPorVisto = aval.valorMax / totalVistosPossiveis;
                    let somaVistos = 0;
                    cls.atividades.forEach(ativ => {
                        let v = (cls.vistos[aluno] && cls.vistos[aluno][ativ.id]) || 0;
                        somaVistos += (v * pesoPorVisto);
                    });
                    nota = somaVistos;
                }
            }
            else if(aval.tipo === 'comportamento') {
                nota = aval.valorMax;
                if(cls.config.desconto_ativo) {
                    let totalOcorrencias = cls.ocorrencias.filter(o => o.aluno === aluno).length;
                    nota -= (totalOcorrencias * (cls.config.desconto_ocorrencia || 0));
                }
                if(nota < 0) nota = 0;
            }
            if(nota > aval.valorMax) nota = aval.valorMax;
            
            notas_calculadas[aval.id] = parseFloat(nota.toFixed(2));
            notas_para_soma[aval.id] = parseFloat(nota.toFixed(2));
        });

        let recs = cls.avaliacoes.filter(a => a.tipo === 'recuperacao');
        recs.forEach(rec => {
            let notaRec = (cls.notas_manuais[aluno] && cls.notas_manuais[aluno][rec.id]) || null;
            if(notaRec !== null) {
                let somaTargetsBase = 0;
                let somaTargetsMax = 0;
                (rec.targets || []).forEach(tId => {
                    somaTargetsBase += (notas_para_soma[tId] || 0);
                    let tAval = cls.avaliacoes.find(a => a.id === tId);
                    if(tAval) somaTargetsMax += tAval.valorMax;
                });
                
                if(notaRec > somaTargetsMax) notaRec = somaTargetsMax;

                if(notaRec > somaTargetsBase && rec.targets && rec.targets.length > 0) {
                    rec.targets.forEach(tId => {
                        notas_para_soma[tId] = 0;
                    });
                    notas_para_soma[rec.targets[0]] = notaRec;
                }
                notas_calculadas[rec.id] = notaRec;
            }
        });

        let somaFinal = 0;
        cls.avaliacoes.forEach(aval => {
            if(aval.tipo !== 'recuperacao') {
                somaFinal += (notas_para_soma[aval.id] || 0);
            }
        });

        return { detalhe: notas_calculadas, total: parseFloat(somaFinal.toFixed(1)) };
    },
    renderNotas() {
        let cls = state.classes[state.currentClassId];
        if(!cls) return;
        
        let thead = `<th class="p-3 font-semibold text-slate-600 sticky left-0 bg-slate-100 z-10 w-32">Aluno</th>`;
        cls.avaliacoes.forEach(a => {
            let badge = a.tipo === 'recuperacao' ? 'bg-orange-100 text-orange-800' : 'bg-blue-100 text-blue-800';
            thead += `<th class="p-3 font-semibold text-slate-600 text-center min-w-[120px]">
                ${a.nome} <br><span class="text-[10px] px-1 rounded ${badge}">${a.valorMax} pts</span>
            </th>`;
        });
        thead += `<th class="p-3 font-bold text-slate-800 text-center bg-slate-200">Média Final</th>`;
        document.getElementById('theadGrades').innerHTML = thead;

        let tbody = '';
        cls.alunos.forEach(alunoRaw => {
            const parsed = parseStudentName(alunoRaw);
            let displayAluno = parsed.numero 
                ? `<span class="inline-block bg-slate-200 text-slate-700 font-bold px-1.5 py-0.5 rounded mr-1.5 text-xs">${parsed.numero}</span>${parsed.nome}`
                : parsed.nome;

            let calcs = this.calcAlunoNotas(cls, alunoRaw);
            tbody += `<tr><td class="p-3 border-b sticky left-0 bg-white z-10 font-medium">${displayAluno}</td>`;
            
            cls.avaliacoes.forEach(aval => {
                let valExibir = calcs.detalhe[aval.id];
                if(aval.tipo === 'manual' || aval.tipo === 'recuperacao') {
                    let rawVal = (cls.notas_manuais[alunoRaw] && cls.notas_manuais[alunoRaw][aval.id]);
                    tbody += `<td class="p-3 border-b text-center"><input type="number" step="0.1" max="${aval.valorMax}" class="w-16 border rounded text-center p-1 text-sm ${rawVal!==undefined?'bg-blue-50':''}" value="${rawVal!==undefined?rawVal:''}" onblur="app.updateManualNota('${alunoRaw}', '${aval.id}', this)"></td>`;
                } else {
                    tbody += `<td class="p-3 border-b text-center text-sm font-semibold text-slate-600 bg-slate-50">${valExibir !== undefined ? valExibir : '-'}</td>`;
                }
            });
            
            let colorClass = calcs.total >= 6.0 ? 'text-green-600' : (calcs.total >= 4.0 ? 'text-orange-500' : 'text-red-600');
            tbody += `<td class="p-3 border-b text-center font-bold text-lg bg-slate-100 ${colorClass}">${calcs.total}</td></tr>`;
        });
        document.getElementById('tbodyGrades').innerHTML = tbody;
    },

 printGrades() {
        const cls = state.classes[state.currentClassId];
        if (!cls) return alert('Selecione uma turma primeiro.');
        let html = `<h1>Quadro de Notas</h1><p><strong>Turma:</strong> ${cls.nome}</p><table class="print-table print-grades-table"><thead><tr><th>Aluno</th>`;
        cls.avaliacoes.forEach(a => { html += `<th>${a.nome}<br><small>${a.valorMax} pts</small></th>`; });
        html += '<th>Média Final</th></tr></thead><tbody>';
        cls.alunos.forEach(aluno => {
            const p = parseStudentName(aluno);
            const calcs = this.calcAlunoNotas(cls, aluno);
            const nomeExibicao = p.numero ? `${p.numero} - ${p.nome}` : p.nome;
            html += `<tr><td>${nomeExibicao}</td>`;
            cls.avaliacoes.forEach(a => {
                let value = calcs.detalhe[a.id];
                if (a.tipo === 'manual' || a.tipo === 'recuperacao') {
                    value = cls.notas_manuais[aluno]?.[a.id];
                }
                html += `<td>${value === undefined || value === '' ? '' : Number(value).toFixed(2)}</td>`;
            });
            html += `<td><strong>${Number(calcs.total).toFixed(1)}</strong></td></tr>`;
        });
        html += '</tbody></table>';
        document.getElementById('printArea').innerHTML = html;
        window.print();
        setTimeout(() => document.getElementById('printArea').innerHTML = '', 1000);
    },

    startNewTerm() {
        if(!confirm("Iniciar novo trimestre? Zerará notas, vistos e ocorrências atuais mantendo alunos e estrutura.")) return;
        let cls = state.classes[state.currentClassId];
        let histId = 'hist_' + Date.now();
        db.ref(`historico/${state.currentClassId}/${histId}`).set(cls);
        
        cls.vistos = {};
        cls.ocorrencias = [];
        cls.notas_manuais = {};
        saveData();
        this.refreshCurrentTab();
        alert("Novo trimestre iniciado com sucesso!");
    },
    clearData() {
        if(!confirm("ATENÇÃO: Limpar todos os dados lançados desta turma?")) return;
        let cls = state.classes[state.currentClassId];
        cls.vistos = {};
        cls.ocorrencias = [];
        cls.notas_manuais = {};
        saveData();
        this.refreshCurrentTab();
    }
};

// ==========================================
// 5. MÓDULO DE VOZ CONTEXTUAL & GEMINI AI (MODO CONTÍNUO LIMPO)
// ==========================================
const voice = {
    recognition: null,
    activeMode: null, 
    transcriptBuffer: '',
    isListening: false,
    isPaused: false,
    isProcessing: false,
    userStopped: false,

    init() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            this.recognition = new SpeechRecognition();
            this.recognition.lang = 'pt-BR';
            this.recognition.interimResults = true;
            this.recognition.continuous = true;
            
            this.recognition.onstart = () => {
                this.isListening = true;
                this.isProcessing = false;
                document.getElementById('voiceStatusBar').classList.remove('hidden');
                document.getElementById('voiceStatusText').innerText = `🔴 Gravando [${this.activeMode.toUpperCase()}]: Pode falar...`;
                this.updateButtonLabel('Encerrar fala');
                this.setPauseControls('Pausar', false);
            };
            
            this.recognition.onresult = (event) => {
                let currentInterim = '';
                
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        this.transcriptBuffer += event.results[i][0].transcript + ' ';
                    } else {
                        currentInterim += event.results[i][0].transcript;
                    }
                }
                
                const displayText = (this.transcriptBuffer + currentInterim).trim();
                document.getElementById('voiceStatusText').innerText = `Ouvindo: "${displayText}"`;
            };
            
            this.recognition.onerror = (e) => {
                if (e.error !== 'no-speech' && e.error !== 'aborted') {
                    console.warn("Aviso no microfone:", e.error);
                }
                if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                    this.userStopped = true;
                    this.stopUI();
                }
            };
            
            this.recognition.onend = () => {
                // Se o usuário NÃO clicou em "Encerrar fala" e não está pausado,
                // reativa o microfone mantendo o histórico de frases limpo acumulado.
                if (!this.userStopped && !this.isPaused && this.isListening) {
                    try {
                        this.recognition.start();
                    } catch (e) {
                        setTimeout(() => {
                            if (!this.userStopped && !this.isPaused) {
                                try { this.recognition.start(); } catch (err) {}
                            }
                        }, 200);
                    }
                    return;
                }

                // Quando o usuário clica para encerrar
                if (this.userStopped) {
                    this.isListening = false;
                    this.updateButtonLabel('Ditar por Voz');
                    this.setPauseControls('Pausar', true);

                    const textToProcess = this.transcriptBuffer.trim();
                    if (textToProcess && !this.isProcessing) {
                        this.isProcessing = true;
                        document.getElementById('voiceStatusText').innerText = `Processando IA: "${textToProcess}"... aguarde.`;
                        this.processCommand(textToProcess);
                    } else {
                        this.stopUI();
                    }
                }
            };
        }
    },
    
    start(mode) {
        if(!state.currentClassId) return alert("Selecione uma turma primeiro!");
        if (this.isListening && this.activeMode === mode) {
            this.stop();
            return;
        }
        this.activeMode = mode;
        this.transcriptBuffer = '';
        this.userStopped = false;
        this.isPaused = false;
        
        if(this.recognition) {
            try { this.recognition.start(); } catch(e) {}
        } else {
            alert("O seu navegador não suporta a Web Speech API.");
        }
    },
    
    stop() {
        this.userStopped = true;
        this.isListening = false;
        if (this.recognition) {
            try { this.recognition.stop(); } catch(e) {}
        }
        this.updateButtonLabel('Ditar por Voz');
        this.setPauseControls('Pausar', true);
    },

    togglePause() {
        if (!this.recognition || !this.activeMode) return;
        if (this.isListening && !this.isPaused) {
            this.isPaused = true;
            try { this.recognition.stop(); } catch (e) {}
            this.setPauseControls('Retomar', false);
            document.getElementById('voiceStatusText').innerText = `Pausado. Texto acumulado: "${this.transcriptBuffer}"`;
        } else if (this.isPaused) {
            this.isPaused = false;
            this.userStopped = false;
            try { this.recognition.start(); } catch (e) {}
            this.setPauseControls('Pausar', false);
        }
    },

    setPauseControls(label, disabled) {
        document.querySelectorAll('.voice-pause-control').forEach(button => {
            button.innerText = label;
            button.disabled = disabled;
        });
        const statusButton = document.getElementById('voicePauseButton');
        if (statusButton) {
            statusButton.innerText = label;
            statusButton.disabled = disabled;
        }
    },

    updateButtonLabel(label) {
        const button = document.getElementById(`btnVoice${this.activeMode === 'vistos' ? 'Activities' : this.activeMode === 'ocorrencia' ? 'Occurrences' : 'Grades'}`);
        const span = button?.querySelector('span');
        if (span) span.textContent = label;
    },
    
    stopUI() {
        document.getElementById('voiceStatusBar').classList.add('hidden');
    },

    async processCommand(text) {
        let cls = state.classes[state.currentClassId];
        if (!cls) return;

        let alunosMapeados = cls.alunos.map(alunoRaw => {
            const p = parseStudentName(alunoRaw);
            return { raw: alunoRaw, numero: p.numero, nome: p.nome };
        });

        let evalsMap = cls.avaliacoes.map(a => `${a.id}="${a.nome}" (tipo=${a.tipo}, máximo=${a.valorMax})`).join(', ');
        let ativsMap = cls.atividades.map(a => `${a.id}="${a.nome}"`).join(', ');

        const systemPrompt = `Você é um assistente escolar especialista em interpretar gravações de áudio de professores.
CONTEXTO ATUAL: O professor está na aba de "${this.activeMode.toUpperCase()}".

LISTA DE ALUNOS CADASTRADOS NA TURMA:
${JSON.stringify(alunosMapeados)}

ATIVIDADES EXISTENTES (ID="Nome"): [${ativsMap}].
AVALIAÇÕES MANUAIS EXISTENTES (ID="Nome"): [${evalsMap}].

TEXTO FALADO PELO PROFESSOR:
"${text}"

REGRAS OBRIGATÓRIAS:
1. Mapeie o aluno para a propriedade "aluno_raw" usando o valor exato contido no campo "raw" da lista. O professor pode falar apenas o primeiro nome ou sobrenome; associe ao aluno correspondente na lista.
2. Modo "vistos":
   - "valor": 1 quando indicar realização completa/fez/concluiu/entregou/certo.
   - "valor": 0.5 quando indicar realização parcial/incompleta/metade/parcial.
   - "valor": 0 quando indicar não realizou/não fez/faltou/não entregou.
   - Identifique SEMPRE o NOME DA ATIVIDADE dita pelo professor (ex: "perímetro", "área", "maquete", "exercício 1") e preencha o campo "atividade_nome" com esse nome.
   - Se o professor citar o nome de uma atividade já existente em ATIVIDADES EXISTENTES, preencha "atividade_id" com o ID correspondente E "atividade_nome" com o nome.
   - Se for uma NOVA atividade não listada em ATIVIDADES EXISTENTES, informe o nome informado pelo professor no campo "atividade_nome" (NUNCA coloque "Atividade por voz" se o professor falou o nome da atividade).
   - Quando o professor ditar uma frase informando uma atividade e vários alunos (ex: "Atividade perímetro ana fez carlos não fez juliana parcial"), gere um objeto separado para CADA aluno contendo o mesmo "atividade_nome" ("perímetro").
3. Modo "ocorrencia":
   - Coloque a descrição da infração na propriedade "descricao".
4. Modo "notas":
   - Coloque a nota numérica em "valor" e o nome/ID da avaliação em "avaliacao_nome" / "avaliacao_id".

Retorne EXCLUSIVAMENTE um array de objetos JSON.
Exemplo:
[
  { "acao": "${this.activeMode}", "aluno_raw": "1 ALAN GABRIEL DIAS", "atividade_nome": "Perímetro", "valor": 1 },
  { "acao": "${this.activeMode}", "aluno_raw": "6 CARLOS DANIEL LUCASKI", "atividade_nome": "Perímetro", "valor": 0 }
]`;

        try {
            const user = auth.currentUser;
            if (!user || user.uid !== ALLOWED_FIREBASE_UID) {
                throw new Error("Sessão Firebase inválida. Faça login novamente.");
            }

            const idToken = await user.getIdToken();
            const response = await fetch(GEMINI_WORKER_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    mode: this.activeMode,
                    text: systemPrompt,
                    alunos: alunosMapeados,
                    atividades: cls.atividades,
                    avaliacoes: cls.avaliacoes
                })
            });

            const responseText = await response.text();
            let data;
            try {
                data = responseText ? JSON.parse(responseText) : {};
            } catch (_) {
                throw new Error("Resposta inválida do Worker.");
            }
            if (!response.ok) {
                throw new Error(data?.error || `Worker respondeu HTTP ${response.status}.`);
            }

            const aiText = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
            if (!aiText) throw new Error("Resposta vazia enviada pela inteligência artificial.");
            console.log("Resposta da IA recebida pelo Worker.");

            let commands;
            try {
                commands = JSON.parse(aiText);
            } catch (_) {
                const jsonBlock = aiText.match(/\[[\s\S]*\]/);
                if (!jsonBlock) throw new Error("A IA não retornou JSON válido.");
                commands = JSON.parse(jsonBlock[0]);
            }
            if (!Array.isArray(commands)) {
                commands = commands.commands || commands.lancamentos || commands.acoes || commands.items || [];
            }
            this.executeCommands(commands);
        } catch (error) {
            console.error("Falha no Gemini AI:", error);
            alert(`Falha ao conectar com a IA: ${error.message}\nVerifique a chave, o modelo e a internet.`);
        } finally {
            this.isProcessing = false;
            this.stopUI();
        }
    },

    executeCommands(commands) {
        if(!Array.isArray(commands) || commands.length === 0) {
            alert("O áudio não foi compreendido ou o aluno/atividade não foi encontrado na turma.");
            return;
        }
        
        let count = 0;
        let cls = state.classes[state.currentClassId];

        commands.forEach(cmd => {
            const alunoTarget = resolveStudentRaw(
                cmd.aluno_raw || cmd.aluno || cmd.nome_aluno || cmd.nome,
                cls.alunos
            );
            if(!alunoTarget) return;

            if(this.activeMode === 'vistos') {
                const explicitActivityLabel = cmd.atividade_nome || cmd.atividade || cmd.activity_name;
                const activityLabel = explicitActivityLabel ||
                    (cmd.atividade_id && !String(cmd.atividade_id).startsWith('ativ_') ? cmd.atividade_id : '');
                
                let atividade = null;

                if (explicitActivityLabel || activityLabel) {
                    const searchName = normalizeText(explicitActivityLabel || activityLabel);
                    atividade = cls.atividades.find(a => normalizeText(a.nome) === searchName);
                }

                if (!atividade && cmd.atividade_id) {
                    atividade = cls.atividades.find(a => a.id === cmd.atividade_id);
                }

                if (!atividade) {
                    const finalName = (explicitActivityLabel || activityLabel || 'Atividade por voz').trim();
                    atividade = {
                        id: 'ativ_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                        nome: finalName,
                        data: getNowDateTimeLocal().slice(0, 10).split('-').reverse().slice(0, 2).join('/')
                    };
                    cls.atividades.push(atividade);
                }

                if (!cls.vistos[alunoTarget]) cls.vistos[alunoTarget] = {};
                const valor = parseVistoValue(cmd.valor ?? cmd.nota ?? cmd.status ?? cmd.resultado);
                if (valor === null) return;
                cls.vistos[alunoTarget][atividade.id] = valor;
                count++;
            }
            else if(this.activeMode === 'ocorrencia' && cmd.descricao) {
                cls.ocorrencias.push({
                    id: 'occ_'+Date.now()+Math.random(),
                    aluno: alunoTarget,
                    dataHora: getNowDateTimeLocal(),
                    desc: cmd.descricao
                });
                count++;
            }
            else if(this.activeMode === 'notas') {
                const evaluationLabel = cmd.avaliacao_nome || cmd.avaliacao || cmd.nome_avaliacao || cmd.avaliacao_id;
                let avaliacao = cls.avaliacoes.find(a => a.id === cmd.avaliacao_id);
                if (!avaliacao && evaluationLabel) {
                    const searchName = normalizeText(evaluationLabel);
                    avaliacao = cls.avaliacoes.find(a => normalizeText(a.nome) === searchName);
                    if (!avaliacao) {
                        avaliacao = {
                            id: 'aval_' + Date.now(),
                            nome: String(evaluationLabel).trim(),
                            tipo: 'manual',
                            valorMax: Number(cmd.valor_max) || 10,
                            targets: []
                        };
                        cls.avaliacoes.push(avaliacao);
                    }
                }
                if (!avaliacao || !['manual', 'recuperacao'].includes(avaliacao.tipo)) return;
                const valor = Number(String(cmd.valor ?? cmd.nota ?? '').replace(',', '.'));
                if (!Number.isFinite(valor) || valor < 0) return;
                if (!cls.notas_manuais[alunoTarget]) cls.notas_manuais[alunoTarget] = {};
                cls.notas_manuais[alunoTarget][avaliacao.id] = Math.min(valor, Number(avaliacao.valorMax) || 10);
                count++;
            }
        });

        if (count > 0) {
            saveData();
            app.refreshCurrentTab();
            notifyUser(`${count} lançamento(s) aplicado(s) com sucesso.`);
        } else {
            console.warn('Nenhum comando da IA foi aplicado:', commands);
            notifyUser('A fala foi enviada, mas nenhum lançamento pôde ser aplicado. Mencione o aluno e a atividade ou avaliação.', 'error');
        }
    }
};

// ==========================================
// 6. INICIALIZAÇÃO DA APLICAÇÃO
// ==========================================
window.onload = async () => {
    ui.init();
    voice.init();
    document.getElementById('modalAuth').classList.remove('hidden');

    auth.onAuthStateChanged(async (user) => {
        if (user && user.uid === ALLOWED_FIREBASE_UID) {
            document.getElementById('modalAuth').classList.add('hidden');
            await loadData();
        } else {
            if (user) await auth.signOut();
            document.getElementById('modalAuth').classList.remove('hidden');
        }
    });
};
