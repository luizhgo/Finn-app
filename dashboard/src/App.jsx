import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabase';
import './style.css';
import {
    PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
    BarChart, Bar, XAxis, YAxis, CartesianGrid
} from 'recharts';
import dayjs from 'dayjs';
import 'dayjs/locale/pt-br';
import EmojiPicker from 'emoji-picker-react';

dayjs.locale('pt-br');

// ── Default category config ────────────────────────────────────────
const DEFAULT_CAT_CONFIG = {
    'alimentação': { color: '#f97316', emoji: '🍔' },
    'combustível':  { color: '#ef4444', emoji: '⛽' },
    'farmácia':     { color: '#22c55e', emoji: '💊' },
    'vestuário':    { color: '#a855f7', emoji: '👕' },
    'mercado':      { color: '#06b6d4', emoji: '🛒' },
    'lazer':        { color: '#f59e0b', emoji: '🎮' },
    'transporte':   { color: '#3b82f6', emoji: '🚗' },
    'contas':       { color: '#6366f1', emoji: '🏠' },
    'outros':       { color: '#94a3b8', emoji: '📦' },
};

// Palette for auto-assigning colors to custom categories
const COLOR_PALETTE = [
    '#e879f9','#34d399','#fb923c','#60a5fa','#a78bfa',
    '#f472b6','#4ade80','#facc15','#38bdf8','#818cf8',
];

function buildCatConfig(customCats) {
    const config = { ...DEFAULT_CAT_CONFIG };
    customCats.forEach((c, i) => {
        const nomeChave = c.nome.toLowerCase().trim();
        if (!config[nomeChave]) {
            config[nomeChave] = { 
                color: c.cor || COLOR_PALETTE[i % COLOR_PALETTE.length],
                emoji: c.emoji || '📦',
            };
        }
    });
    return config;
}

function getCatColor(cat, catConfig) {
    return catConfig[cat?.toLowerCase()]?.color ?? '#94a3b8';
}
function getCatEmoji(cat, catConfig) {
    return catConfig[cat?.toLowerCase()]?.emoji ?? '📦';
}

// ── Format helper ──────────────────────────────────────────────────
function fmt(n) {
    return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Months ─────────────────────────────────────────────────────────
const MONTH_NAMES = [
    'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
];

// ── Custom Month Picker ────────────────────────────────────────────
function MonthPicker({ value, onChange }) {
    const [open, setOpen] = useState(false);
    const [viewYear, setViewYear] = useState(() => parseInt(value.split('-')[0]));
    const ref = useRef(null);

    const selYear  = parseInt(value.split('-')[0]);
    const selMonth = parseInt(value.split('-')[1]) - 1;

    useEffect(() => {
        function handleClick(e) {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    function selectMonth(monthIdx) {
        const mm = String(monthIdx + 1).padStart(2, '0');
        onChange(`${viewYear}-${mm}`);
        setOpen(false);
    }

    const label = `${MONTH_NAMES[selMonth]} ${selYear}`;

    return (
        <div className="mp-root" ref={ref}>
            <button className="mp-trigger" onClick={() => setOpen(o => !o)} id="month-picker-btn">
                <span className="mp-icon">📅</span>
                {label}
                <span className="mp-chevron" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
            </button>

            {open && (
                <div className="mp-dropdown">
                    <div className="mp-header">
                        <button className="mp-nav" onClick={() => setViewYear(y => y - 1)}>‹</button>
                        <span className="mp-year">{viewYear}</span>
                        <button className="mp-nav" onClick={() => setViewYear(y => y + 1)}>›</button>
                    </div>
                    <div className="mp-grid">
                        {MONTH_NAMES.map((m, i) => (
                            <button
                                key={i}
                                className={`mp-month ${viewYear === selYear && i === selMonth ? 'active' : ''}`}
                                onClick={() => selectMonth(i)}
                            >
                                {m.slice(0, 3)}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Tooltips ───────────────────────────────────────────────────────
function PieTooltip({ active, payload }) {
    if (!active || !payload?.length) return null;
    const d = payload[0];
    return (
        <div style={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 14px', fontSize: 13 }}>
            <div style={{ color: d.payload.fill, fontWeight: 600 }}>{d.name}</div>
            <div>R$ {fmt(d.value)}</div>
        </div>
    );
}
function BarTooltip({ active, payload }) {
    if (!active || !payload?.length) return null;
    return (
        <div style={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 14px', fontSize: 13 }}>
            <div style={{ fontWeight: 600 }}>{payload[0].payload.dia}</div>
            <div>R$ {fmt(payload[0].value)}</div>
        </div>
    );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════
export default function App() {
    const [transactions, setTransactions]   = useState([]);
    const [metas, setMetas]                 = useState([]);
    const [customCats, setCustomCats]       = useState([]);  // from DB `categorias` table
    const [aliasesCats, setAliasesCats]     = useState([]);  // unique categories from aliases
    const [mesSelecionado, setMesSelecionado] = useState(dayjs().format('YYYY-MM'));
    const [loading, setLoading]             = useState(true);
    const [page, setPage]                   = useState('dashboard');
    const [categoriaAberta, setCategoriaAberta] = useState(null);
    const [editandoId, setEditandoId]       = useState(null);
    const [editForm, setEditForm]           = useState({});
    const [novaMetaForm, setNovaMetaForm]   = useState({ categoria: '', valor: '' });
    const [novaCatForm, setNovaCatForm]     = useState({ nome: '', emoji: '📦', cor: '#94a3b8' });
    const [editandoCatId, setEditandoCatId] = useState(null); // ID of custom category being edited, or alias name
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [salvando, setSalvando]           = useState(false);
    const [metaError, setMetaError]         = useState('');

    // ── Build dynamic cat config ───────────────────────────────────
    const catConfig = buildCatConfig(customCats);
    const allCats   = Object.keys(catConfig);

    // ── Data fetching ──────────────────────────────────────────────
    const carregarDados = useCallback(async () => {
        const { data } = await supabase
            .from('transactions')
            .select('*')
            .order('created_at', { ascending: false });
        setTransactions(data || []);
    }, []);

    const carregarMetas = useCallback(async () => {
        const { data, error } = await supabase.from('metas').select('*');
        if (error) console.error('Erro ao carregar metas:', error);
        setMetas(data || []);
    }, []);

    const carregarCategorias = useCallback(async () => {
        const { data: catData } = await supabase.from('categorias').select('*');
        setCustomCats(catData || []);

        const { data: aliasData } = await supabase.from('aliases').select('categoria');
        const { data: txData } = await supabase.from('transactions').select('categoria');

        const allBotCats = [];
        if (aliasData) allBotCats.push(...aliasData.map(a => a.categoria));
        if (txData)    allBotCats.push(...txData.map(t => t.categoria));

        const unique = [...new Set(allBotCats.filter(Boolean))];
        setAliasesCats(unique);
    }, []);

    useEffect(() => {
        Promise.all([carregarDados(), carregarMetas(), carregarCategorias()])
            .finally(() => setLoading(false));
    }, []);

    // ── Merged category list (defaults + aliases + custom) ─────────
    const mergedExtraCategories = [
        ...aliasesCats.filter(c => !DEFAULT_CAT_CONFIG[c.toLowerCase()]),
        ...customCats.map(c => c.nome).filter(c => !DEFAULT_CAT_CONFIG[c.toLowerCase()]),
    ];
    const uniqueMerged = [...new Set(mergedExtraCategories.map(c => c.toLowerCase().trim()))];
    const botLearned = aliasesCats.filter(c => 
        !customCats.some(cc => cc.nome.toLowerCase() === c.toLowerCase()) && 
        !DEFAULT_CAT_CONFIG[c.toLowerCase()]
    );

    // ── Derived data ───────────────────────────────────────────────
    const dadosFiltrados = transactions.filter(t =>
        dayjs(t.created_at).format('YYYY-MM') === mesSelecionado
    );

    const total   = dadosFiltrados.reduce((acc, t) => acc + (t.valor || 0), 0);
    const count   = dadosFiltrados.length;
    const avg     = count > 0 ? total / count : 0;
    const biggest = count > 0 ? Math.max(...dadosFiltrados.map(t => t.valor || 0)) : 0;

    const agrupado = {};
    dadosFiltrados.forEach(t => {
        const cat = t.categoria || 'outros';
        if (!agrupado[cat]) agrupado[cat] = { total: 0, items: [] };
        agrupado[cat].total += t.valor || 0;
        agrupado[cat].items.push(t);
    });

    const categorias = Object.entries(agrupado).sort((a, b) => b[1].total - a[1].total);

    const dadosPizza = categorias.map(([cat, { total: v }]) => ({
        name: `${getCatEmoji(cat, catConfig)} ${cat}`,
        value: v,
        fill: getCatColor(cat, catConfig),
    }));

    const porDia = {};
    dadosFiltrados.forEach(t => {
        const dia = dayjs(t.created_at).format('DD/MM');
        if (!porDia[dia]) porDia[dia] = 0;
        porDia[dia] += t.valor || 0;
    });
    const dadosBar = Object.entries(porDia)
        .sort((a, b) => {
            const [da, ma] = a[0].split('/').map(Number);
            const [db, mb] = b[0].split('/').map(Number);
            return new Date(2000, ma - 1, da) - new Date(2000, mb - 1, db);
        })
        .map(([dia, valor]) => ({ dia, valor }));

    const metasMap = {};
    metas.forEach(m => { metasMap[m.categoria] = m.valor; });

    const alertas = categorias.flatMap(([cat, { total: gasto }]) => {
        const meta = metasMap[cat];
        if (!meta) return [];
        const pct = (gasto / meta) * 100;
        if (pct >= 100) return [`🚨 ${cat}: estourou a meta! (${fmt(gasto)} / R$${fmt(meta)})`];
        if (pct >= 80)  return [`⚠️ ${cat}: ${pct.toFixed(0)}% da meta (R$${fmt(gasto)} / R$${fmt(meta)})`];
        return [];
    });

    // ── Select options for "all categories" (including custom/alias) ─
    const categoriaSelectOptions = [
        ...Object.keys(DEFAULT_CAT_CONFIG),
        ...uniqueMerged,
    ];

    // ── Actions ────────────────────────────────────────────────────
    async function deletar(id) {
        await supabase.from('transactions').delete().eq('id', id);
        setTransactions(prev => prev.filter(t => t.id !== id));
    }

    function iniciarEdicao(t) {
        setEditandoId(t.id);
        setEditForm({ valor: t.valor, categoria: t.categoria || '', descricao: t.descricao || '' });
    }

    async function salvarEdicao(id) {
        setSalvando(true);
        const { error } = await supabase
            .from('transactions')
            .update({
                valor:     parseFloat(String(editForm.valor).replace(',', '.')),
                categoria: editForm.categoria,
                descricao: editForm.descricao,
            })
            .eq('id', id);

        if (!error) {
            setTransactions(prev => prev.map(t => t.id === id
                ? { ...t, valor: parseFloat(editForm.valor), categoria: editForm.categoria, descricao: editForm.descricao }
                : t
            ));
            setEditandoId(null);
        }
        setSalvando(false);
    }

    async function salvarMeta(e) {
        e.preventDefault();
        setMetaError('');
        if (!novaMetaForm.categoria || !novaMetaForm.valor) return;
        const valor = parseFloat(String(novaMetaForm.valor).replace(',', '.'));

        const existente = metas.find(m => m.categoria === novaMetaForm.categoria);
        let result;
        if (existente) {
            result = await supabase.from('metas').update({ valor }).eq('id', existente.id);
        } else {
            result = await supabase.from('metas').insert([{ categoria: novaMetaForm.categoria, valor }]);
        }

        if (result.error) {
            setMetaError('Erro ao salvar: ' + result.error.message);
            return;
        }

        setNovaMetaForm({ categoria: '', valor: '' });
        carregarMetas();
    }

    function iniciarEdicaoMeta(meta) {
        setNovaMetaForm({ categoria: meta.categoria, valor: meta.valor });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function deletarMeta(id) {
        await supabase.from('metas').delete().eq('id', id);
        setMetas(prev => prev.filter(m => m.id !== id));
    }

    function iniciarEdicaoCategoria(catName, isBot) {
        setEditandoCatId(catName); // We use catName as the ID since it serves as the key conceptually or the actual category object id if custom. Wait, for custom it has an ID.
        // Actually, let's pass the whole object if it's a custom category. 
        // If it's a bot category it only has a name from the aliases.
        const existingCat = customCats.find(c => c.nome === catName);
        if (existingCat) {
            setEditandoCatId(existingCat.id);
            setNovaCatForm({ nome: existingCat.nome, emoji: existingCat.emoji, cor: existingCat.cor });
        } else {
            // It's a bot category without custom properties yet
            setEditandoCatId('bot_' + catName);
            setNovaCatForm({ nome: catName, emoji: getCatEmoji(catName, catConfig), cor: getCatColor(catName, catConfig) });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function salvarCategoria(e) {
        e.preventDefault();
        if (!novaCatForm.nome.trim()) return;

        const catData = {
            nome:  novaCatForm.nome.toLowerCase().trim(),
            emoji: novaCatForm.emoji || '📦',
            cor:   novaCatForm.cor   || '#94a3b8',
        };

        let result;
        if (typeof editandoCatId === 'number') {
            const existingCat = customCats.find(c => c.id === editandoCatId);
            const oldName = existingCat ? existingCat.nome : null;
            
            result = await supabase.from('categorias').update(catData).eq('id', editandoCatId);

            if (!result.error && oldName && oldName !== catData.nome) {
                await supabase.from('transactions').update({ categoria: catData.nome }).eq('categoria', oldName);
                await supabase.from('metas').update({ categoria: catData.nome }).eq('categoria', oldName);
                await supabase.from('aliases').update({ categoria: catData.nome }).eq('categoria', oldName);
            }
        } else {
            result = await supabase.from('categorias').upsert([catData], { onConflict: 'nome' });

            if (!result.error && typeof editandoCatId === 'string' && editandoCatId.startsWith('bot_')) {
                const oldName = editandoCatId.replace('bot_', '');
                if (oldName !== catData.nome) {
                    await supabase.from('transactions').update({ categoria: catData.nome }).eq('categoria', oldName);
                    await supabase.from('metas').update({ categoria: catData.nome }).eq('categoria', oldName);
                    await supabase.from('aliases').update({ categoria: catData.nome }).eq('categoria', oldName);
                }
            }
        }

        if (!result.error) {
            setNovaCatForm({ nome: '', emoji: '📦', cor: '#94a3b8' });
            setEditandoCatId(null);
            carregarCategorias();
            carregarMetas();
            carregarDados();
        }
    }

    async function deletarCategoria(id) {
        await supabase.from('categorias').delete().eq('id', id);
        setCustomCats(prev => prev.filter(c => c.id !== id));
        if (editandoCatId === id) {
            setEditandoCatId(null);
            setNovaCatForm({ nome: '', emoji: '📦', cor: '#94a3b8' });
        }
    }


    // ── Loading ────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="loading-screen">
                <div className="spinner" />
                Carregando dados…
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════
    // RENDER
    // ══════════════════════════════════════════════════════════════
    return (
        <div className="app-layout">

            {/* ── SIDEBAR ──────────────────────────────────────── */}
            <aside className="sidebar">
                <div className="sidebar-logo">
                    <div className="sidebar-logo-icon">💸</div>
                    <span className="sidebar-logo-name">Finn</span>
                </div>

                <nav className="sidebar-nav">
                    {[
                        { id: 'dashboard',   icon: '📊', label: 'Dashboard' },
                        { id: 'metas',       icon: '🎯', label: 'Metas' },
                        { id: 'categorias',  icon: '🏷️', label: 'Categorias' },
                    ].map(({ id, icon, label }) => (
                        <button
                            key={id}
                            id={`nav-${id}`}
                            className={`nav-item ${page === id ? 'active' : ''}`}
                            onClick={() => setPage(id)}
                        >
                            <span className="nav-item-icon">{icon}</span>
                            <span>{label}</span>
                        </button>
                    ))}
                </nav>
            </aside>

            {/* ── MAIN ─────────────────────────────────────────── */}
            <main className="main-content fade-in">

                {/* PAGE HEADER */}
                <div className="page-header">
                    <div>
                        <h1 className="page-title">
                            {page === 'dashboard'  && '📊 Dashboard'}
                            {page === 'metas'      && '🎯 Metas'}
                            {page === 'categorias' && '🏷️ Categorias'}
                        </h1>
                        <p className="page-subtitle">
                            {page === 'dashboard'  && `${count} transaç${count !== 1 ? 'ões' : 'ão'} em ${dayjs(mesSelecionado + '-01').format('MMMM [de] YYYY')}`}
                            {page === 'metas'      && `${metas.length} meta${metas.length !== 1 ? 's' : ''} configurada${metas.length !== 1 ? 's' : ''}`}
                            {page === 'categorias' && `${customCats.length} categorias personalizadas · ${uniqueMerged.length} aprendidas pelo bot`}
                        </p>
                    </div>
                    {page === 'dashboard' && (
                        <MonthPicker value={mesSelecionado} onChange={setMesSelecionado} />
                    )}
                </div>

                {/* ══ DASHBOARD ════════════════════════════════════ */}
                {page === 'dashboard' && (
                    <>
                        {alertas.length > 0 && (
                            <div className="alert-banner">
                                <div className="alert-banner-title">⚠️ Atenção</div>
                                {alertas.map((a, i) => (
                                    <div key={i} className="alert-item">{a}</div>
                                ))}
                            </div>
                        )}

                        {/* STAT CARDS */}
                        <div className="stats-grid">
                            <div className="card stat-card total">
                                <div className="stat-icon">💰</div>
                                <div className="stat-label">Total do mês</div>
                                <div className="stat-value currency">{fmt(total)}</div>
                            </div>
                            <div className="card stat-card count">
                                <div className="stat-icon">🧾</div>
                                <div className="stat-label">Transações</div>
                                <div className="stat-value">{count}</div>
                            </div>
                            <div className="card stat-card avg">
                                <div className="stat-icon">📈</div>
                                <div className="stat-label">Média por gasto</div>
                                <div className="stat-value currency">{fmt(avg)}</div>
                            </div>
                            <div className="card stat-card biggest">
                                <div className="stat-icon">🔝</div>
                                <div className="stat-label">Maior gasto</div>
                                <div className="stat-value currency">{fmt(biggest)}</div>
                            </div>
                        </div>

                        {/* CHARTS */}
                        {dadosFiltrados.length > 0 && (
                            <div className="charts-grid">
                                <div className="card chart-card">
                                    <div className="chart-title">Por Categoria</div>
                                    <ResponsiveContainer width="100%" height={260}>
                                        <PieChart>
                                            <Pie data={dadosPizza} dataKey="value" innerRadius={55} outerRadius={100} paddingAngle={3}>
                                                {dadosPizza.map((entry, i) => (
                                                    <Cell key={i} fill={entry.fill} stroke="transparent" />
                                                ))}
                                            </Pie>
                                            <Tooltip content={<PieTooltip />} />
                                            <Legend formatter={(v) => <span style={{ color: '#94a3b8', fontSize: 12 }}>{v}</span>} />
                                        </PieChart>
                                    </ResponsiveContainer>
                                </div>

                                <div className="card chart-card">
                                    <div className="chart-title">Gastos por Dia</div>
                                    <ResponsiveContainer width="100%" height={260}>
                                        <BarChart data={dadosBar} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                            <XAxis dataKey="dia" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                                            <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                                            <Tooltip content={<BarTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                                            <Bar dataKey="valor" radius={[4, 4, 0, 0]} fill="#6366f1" />
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}

                        {/* CATEGORIES */}
                        <h2 className="section-title">📂 Por Categoria</h2>

                        {categorias.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon">🌙</div>
                                Nenhum gasto registrado neste mês.
                            </div>
                        ) : (
                            <div className="categories-list">
                                {categorias.map(([cat, { total: catTotal, items }]) => {
                                    const isOpen = categoriaAberta === cat;
                                    const meta   = metasMap[cat];
                                    const pct    = meta ? Math.min((catTotal / meta) * 100, 100) : null;
                                    const pClass = pct === null ? '' : pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'safe';

                                    return (
                                        <div key={cat} className={`category-card ${isOpen ? 'open' : ''}`}>
                                            <div className="category-header" onClick={() => setCategoriaAberta(isOpen ? null : cat)}>
                                                <span className="cat-dot" style={{ background: getCatColor(cat, catConfig) }} />
                                                <span className="cat-name">{getCatEmoji(cat, catConfig)} {cat}</span>
                                                <span className="cat-count">{items.length}</span>
                                                <span className="cat-value">R$ {fmt(catTotal)}</span>
                                                <span className="cat-chevron">▶</span>
                                            </div>

                                            {pct !== null && (
                                                <div className="cat-progress-bar">
                                                    <div className={`cat-progress-fill ${pClass}`} style={{ width: `${pct}%`, background: getCatColor(cat, catConfig) }} />
                                                </div>
                                            )}

                                            {isOpen && (
                                                <div className="transactions-list">
                                                    {items.map(t => (
                                                        editandoId === t.id ? (
                                                            <div key={t.id} className="edit-row">
                                                                <div className="edit-fields">
                                                                    <input
                                                                        id={`edit-valor-${t.id}`}
                                                                        className="edit-input"
                                                                        type="number"
                                                                        placeholder="Valor"
                                                                        value={editForm.valor}
                                                                        onChange={e => setEditForm(f => ({ ...f, valor: e.target.value }))}
                                                                    />
                                                                    <select
                                                                        id={`edit-cat-${t.id}`}
                                                                        className="edit-input"
                                                                        value={editForm.categoria.toLowerCase()}
                                                                        onChange={e => setEditForm(f => ({ ...f, categoria: e.target.value }))}
                                                                    >
                                                                        {categoriaSelectOptions.map(c => (
                                                                            <option key={c} value={c}>{getCatEmoji(c, catConfig)} {c}</option>
                                                                        ))}
                                                                    </select>
                                                                    <input
                                                                        id={`edit-desc-${t.id}`}
                                                                        className="edit-input desc"
                                                                        type="text"
                                                                        placeholder="Descrição"
                                                                        value={editForm.descricao}
                                                                        onChange={e => setEditForm(f => ({ ...f, descricao: e.target.value }))}
                                                                    />
                                                                </div>
                                                                <div className="edit-actions">
                                                                    <button id={`save-edit-${t.id}`} className="btn btn-primary btn-sm" onClick={() => salvarEdicao(t.id)} disabled={salvando}>
                                                                        {salvando ? '…' : '✅ Salvar'}
                                                                    </button>
                                                                    <button className="btn btn-ghost btn-sm" onClick={() => setEditandoId(null)}>Cancelar</button>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div key={t.id} className="transaction-row">
                                                                <div className="tx-main">
                                                                    <span className="tx-desc">{t.descricao || '—'}</span>
                                                                    <span className="tx-date">{dayjs(t.created_at).format('DD/MM/YYYY [às] HH:mm')}</span>
                                                                </div>
                                                                <span className="tx-value">R$ {fmt(t.valor)}</span>
                                                                <div className="tx-actions">
                                                                    <button id={`edit-btn-${t.id}`} className="btn-icon" title="Editar" onClick={() => iniciarEdicao(t)}>✏️</button>
                                                                    <button id={`del-btn-${t.id}`} className="btn-icon delete" title="Deletar" onClick={() => deletar(t.id)}>🗑️</button>
                                                                </div>
                                                            </div>
                                                        )
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}

                {/* ══ METAS ════════════════════════════════════════ */}
                {page === 'metas' && (
                    <>
                        <div className="card meta-form">
                            <div className="meta-form-title">Nova Meta / Editar Existente</div>
                            {metaError && <div className="error-msg">❌ {metaError}</div>}
                            <form onSubmit={salvarMeta}>
                                <div className="meta-form-fields">
                                    <div className="form-group">
                                        <label className="form-label">Categoria</label>
                                        <select
                                            id="meta-categoria"
                                            className="form-select"
                                            value={novaMetaForm.categoria.toLowerCase()}
                                            onChange={e => setNovaMetaForm(f => ({ ...f, categoria: e.target.value }))}
                                            required
                                        >
                                            <option value="">Selecionar…</option>
                                            <optgroup label="Padrão">
                                                {Object.keys(DEFAULT_CAT_CONFIG).filter(c => c !== 'outros').map(c => (
                                                    <option key={c} value={c}>{getCatEmoji(c, catConfig)} {c}</option>
                                                ))}
                                            </optgroup>
                                            {uniqueMerged.length > 0 && (
                                                <optgroup label="Personalizadas / Bot">
                                                    {uniqueMerged.map(c => (
                                                        <option key={c} value={c}>{getCatEmoji(c, catConfig)} {c}</option>
                                                    ))}
                                                </optgroup>
                                            )}
                                        </select>
                                    </div>
                                    <div className="form-group">
                                        <label className="form-label">Valor limite (R$)</label>
                                        <input
                                            id="meta-valor"
                                            className="form-input"
                                            type="number"
                                            placeholder="ex: 500"
                                            value={novaMetaForm.valor}
                                            onChange={e => setNovaMetaForm(f => ({ ...f, valor: e.target.value }))}
                                            required
                                        />
                                    </div>
                                    <button id="salvar-meta" type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }}>
                                        ✅ Salvar Meta
                                    </button>
                                </div>
                            </form>
                        </div>

                        {metas.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon">🎯</div>
                                Nenhuma meta configurada ainda.
                            </div>
                        ) : (
                            <div className="metas-grid">
                                {metas.map(meta => {
                                    const gasto = agrupado[meta.categoria]?.total || 0;
                                    const pct   = Math.min((gasto / meta.valor) * 100, 100);
                                    const pClass = pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'safe';

                                    return (
                                        <div key={meta.id} className="card meta-card">
                                            <div className="meta-header">
                                                <div className="meta-name">
                                                    <span className="meta-dot" style={{ background: getCatColor(meta.categoria, catConfig) }} />
                                                    {getCatEmoji(meta.categoria, catConfig)} {meta.categoria}
                                                </div>
                                                <div style={{display:'flex', gap: '8px'}}>
                                                    <button className="meta-edit-btn" onClick={() => iniciarEdicaoMeta(meta)} title="Editar meta">✏️</button>
                                                    <button id={`del-meta-${meta.id}`} className="meta-delete-btn" onClick={() => deletarMeta(meta.id)} title="Remover meta">✕</button>
                                                </div>
                                            </div>
                                            <div className="meta-values">
                                                <span className="meta-spent" style={{ color: getCatColor(meta.categoria, catConfig) }}>R$ {fmt(gasto)}</span>
                                                <span className="meta-limit">/ R$ {fmt(meta.valor)}</span>
                                            </div>
                                            <div className="meta-progress-track">
                                                <div className={`meta-progress-fill ${pClass}`} style={{ width: `${pct}%` }} />
                                            </div>
                                            <div className="meta-percent">
                                                {pct >= 100 ? '🚨 Meta estourada!' : pct >= 80 ? `⚠️ ${pct.toFixed(0)}% utilizado` : `${pct.toFixed(0)}% utilizado (mês atual)`}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}

                {/* ══ CATEGORIAS ═══════════════════════════════════ */}
                {page === 'categorias' && (
                    <>
                        {/* ADD FORM */}
                        <div className="card meta-form" style={{ marginBottom: 24 }}>
                            <div className="meta-form-title">{editandoCatId ? 'Editar Categoria' : 'Criar nova categoria personalizada'}</div>
                            <form onSubmit={salvarCategoria}>
                                <div className="meta-form-fields">
                                    <div className="form-group">
                                        <label className="form-label">Nome</label>
                                        <input
                                            id="cat-nome"
                                            className="form-input"
                                            type="text"
                                            placeholder="ex: presentes"
                                            value={novaCatForm.nome}
                                            onChange={e => setNovaCatForm(f => ({ ...f, nome: e.target.value }))}
                                            required
                                        />
                                    </div>
                                    <div className="form-group" style={{ maxWidth: 80, position: 'relative' }}>
                                        <label className="form-label">Emoji</label>
                                        <div style={{ display: 'flex', gap: '4px' }}>
                                            <input
                                                id="cat-emoji"
                                                className="form-input"
                                                type="text"
                                                maxLength={4}
                                                placeholder="🎁"
                                                value={novaCatForm.emoji}
                                                onChange={e => setNovaCatForm(f => ({ ...f, emoji: e.target.value }))}
                                                style={{flex: 1, padding: '0 8px', textAlign: 'center'}}
                                            />
                                            <button 
                                                type="button" 
                                                className="btn"
                                                style={{padding: '0 8px'}}
                                                onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
                                                😀
                                            </button>
                                        </div>
                                        {showEmojiPicker && (
                                            <div style={{ position: 'absolute', top: 70, left: 0, zIndex: 9999 }}>
                                                <EmojiPicker
                                                    onEmojiClick={(emojiData) => {
                                                        setNovaCatForm(f => ({...f, emoji: emojiData.emoji}));
                                                        setShowEmojiPicker(false);
                                                    }}
                                                    theme="dark"
                                                />
                                            </div>
                                        )}
                                    </div>
                                    <div className="form-group" style={{ maxWidth: 80 }}>
                                        <label className="form-label">Cor</label>
                                        <input
                                            id="cat-cor"
                                            className="form-input color-input"
                                            type="color"
                                            value={novaCatForm.cor}
                                            onChange={e => setNovaCatForm(f => ({ ...f, cor: e.target.value }))}
                                        />
                                    </div>
                                    <div style={{ alignSelf: 'flex-end', display: 'flex', gap: '8px' }}>
                                        {editandoCatId && (
                                            <button type="button" className="btn" onClick={() => { setEditandoCatId(null); setNovaCatForm({ nome: '', emoji: '📦', cor: '#94a3b8' }); }}>
                                                Cancelar
                                            </button>
                                        )}
                                        <button id="salvar-cat" type="submit" className="btn btn-primary">
                                            {editandoCatId ? '✅ Salvar' : '+ Criar'}
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div>

                        {/* CATEGORIES LEARNED BY BOT */}
                        {botLearned.length > 0 && (
                            <>
                                <h2 className="section-title" style={{ marginBottom: 12 }}>🤖 Aprendidas pelo Bot</h2>
                                <div className="cat-chips-grid">
                                    {botLearned.map(cat => (
                                        <div key={cat} className="cat-chip">
                                            <span className="cat-chip-dot" style={{ background: getCatColor(cat, catConfig) }} />
                                            <span>{getCatEmoji(cat, catConfig)} {cat}</span>
                                            <span className="cat-chip-badge">bot</span>
                                            <div style={{ marginLeft: '12px', display: 'flex', gap: '4px' }}>
                                                <button className="cat-chip-edit" onClick={() => iniciarEdicaoCategoria(cat, true)} title="Personalizar">✏️</button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}

                        {/* CUSTOM CATEGORIES */}
                        <h2 className="section-title" style={{ marginTop: 24, marginBottom: 12 }}>🏷️ Personalizadas</h2>
                        {customCats.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon">🏷️</div>
                                Nenhuma categoria personalizada ainda.
                            </div>
                        ) : (
                            <div className="cat-chips-grid">
                                {customCats.map(cat => (
                                    <div key={cat.id} className="cat-chip">
                                        <span className="cat-chip-dot" style={{ background: cat.cor }} />
                                        <span>{cat.emoji} {cat.nome}</span>
                                        <div style={{ marginLeft: '12px', display: 'flex', gap: '4px' }}>
                                            <button className="cat-chip-edit" onClick={() => iniciarEdicaoCategoria(cat.nome, false)} title="Editar">✏️</button>
                                            <button className="cat-chip-del" onClick={() => deletarCategoria(cat.id)} title="Excluir">✕</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* DEFAULT CATEGORIES (read-only reference) */}
                        <h2 className="section-title" style={{ marginTop: 24, marginBottom: 12 }}>📋 Padrão do sistema</h2>
                        <div className="cat-chips-grid">
                            {Object.entries(DEFAULT_CAT_CONFIG).map(([name, { color, emoji }]) => (
                                <div key={name} className="cat-chip readonly">
                                    <span className="cat-chip-dot" style={{ background: color }} />
                                    <span>{emoji} {name}</span>
                                </div>
                            ))}
                        </div>
                    </>
                )}

            </main>
        </div>
    );
}