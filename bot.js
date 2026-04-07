// ==============================
// 📦 IMPORTS
// ==============================
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const https = require('https');


// ==============================
// 🔐 CONFIG
// ==============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY || 'SUA_OPENAI_API_KEY_AQUI';


// ==============================
// 🔌 CONEXÕES
// ==============================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_KEY });


// ==============================
// 🧠 ESTADO
// ==============================
const estados = {};
let aliasesDB = {};

// Mapa para Undo: { [chatId]: { id, timeout } }
const pendingUndo = {};


// ==============================
// 🔄 CARREGAR ALIASES
// ==============================
async function carregarAliases() {
    const { data, error } = await supabase.from('aliases').select('*');

    if (error) {
        console.log('ERRO AO CARREGAR ALIASES:', error);
    }

    if (data) {
        data.forEach(item => {
            aliasesDB[item.palavra] = item.categoria;
        });
        console.log(`✅ ${data.length} aliases carregados.`);
    }
}
carregarAliases();


// ==============================
// 🔤 NORMALIZAR
// ==============================
function normalizarTexto(texto) {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}


// ==============================
// 💰 EXTRAIR VALOR
// ==============================
function extrairValor(texto) {
    const match = texto.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+[.,]?\d*/);
    if (!match) return 0;

    let valor = match[0];
    valor = valor.replace(/\./g, '').replace(',', '.');

    return parseFloat(valor);
}


// ==============================
// 🧠 DETECTAR CATEGORIA
// ==============================
function detectarCategoria(texto) {

    for (const [palavra, categoria] of Object.entries(aliasesDB)) {
        if (texto.includes(palavra)) {
            return categoria;
        }
    }

    if (texto.includes('gasolina')) return 'combustivel';
    if (texto.includes('uber')) return 'transporte';
    if (texto.includes('pizza')) return 'alimentacao';
    if (texto.includes('ifood')) return 'alimentacao';
    if (texto.includes('mercado')) return 'mercado';
    if (texto.includes('farmacia')) return 'farmacia';
    if (texto.includes('remedio')) return 'farmacia';

    return 'outros';
}


// ==============================
// 📅 EXTRAIR DATA
// ==============================
function extrairData(texto) {
    const agora = new Date();
    let label = 'hoje';

    if (texto.includes('anteontem')) {
        agora.setDate(agora.getDate() - 2);
        label = 'anteontem';
    } else if (texto.includes('ontem')) {
        agora.setDate(agora.getDate() - 1);
        label = 'ontem';
    } else {
        // Regex mais restrita: "dia 15", "dia 15/04", "15/04", "15/04/2026"
        // Evita capturar números soltos que podem ser o valor
        const regexDia = /(?:dia\s+(\d{1,2})(?:\/(\d{1,2}))?)|(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s|$)/i;
        const match = texto.match(regexDia);
        if (match) {
            const dia = parseInt(match[1] || match[3]);
            const mes = (match[2] || match[4]) ? parseInt(match[2] || match[4]) - 1 : agora.getMonth();
            const ano = match[5] ? (match[5].length === 2 ? 2000 + parseInt(match[5]) : parseInt(match[5])) : agora.getFullYear();

            if (dia >= 1 && dia <= 31 && mes >= 0 && mes <= 11) {
                agora.setFullYear(ano);
                agora.setDate(1); // Proteção contra meses curtos (ex: 31 de Março -> Fevereiro)
                agora.setMonth(mes);
                agora.setDate(dia);
                label = match[0].trim();
            }
        }
    }

    return { iso: agora.toISOString(), label };
}


// ==============================
// 🧾 LIMPAR DESCRIÇÃO
// ==============================
function limparDescricao(textoOriginal) {
    let t = textoOriginal.replace(/gastei|paguei|comprei|r\$|reais/gi, '');
    t = t.replace(/\b(anteontem|ontem)\b/gi, '');
    t = t.replace(/(?:no\s+)?(?:dia\s+\d{1,2}(?:\/\d{1,2})?)/gi, '');
    t = t.replace(/(?:^|\s)\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?=\s|$)/gi, ' ');
    return t.trim().replace(/\s+/g, ' ');
}


// ==============================
// 🧩 PARSER
// ==============================
function interpretarTexto(textoOriginal) {
    const texto = normalizarTexto(textoOriginal);

    const valor = extrairValor(texto);
    const categoria = detectarCategoria(texto);
    const data = extrairData(texto);
    const descricao = limparDescricao(textoOriginal);

    return { valor, categoria, descricao, created_at: data.iso, data_label: data.label };
}


// ==============================
// 💾 SALVAR TRANSAÇÃO (helper)
// ==============================
async function salvarTransacao(chatId, dados) {
    const { data, error } = await supabase
        .from('transactions')
        .insert([{
            valor: dados.valor,
            categoria: dados.categoria,
            descricao: dados.descricao,
            created_at: dados.created_at
        }])
        .select()
        .single();

    if (error) {
        console.log('ERRO TRANSACTION:', error);
        bot.sendMessage(chatId, '❌ Erro ao salvar gasto.');
        return null;
    }
    return data;
}


// ==============================
// ↩️ OFERECER UNDO
// ==============================
function oferecerUndo(chatId, txId, texto) {
    // Cancela undo anterior pendente deste chat
    if (pendingUndo[chatId]) {
        clearTimeout(pendingUndo[chatId].timeout);
        delete pendingUndo[chatId];
    }

    const timeout = setTimeout(() => {
        delete pendingUndo[chatId];
    }, 30000);

    pendingUndo[chatId] = { id: txId, timeout };

    bot.sendMessage(chatId, texto, {
        reply_markup: {
            inline_keyboard: [[
                { text: '↩️ Desfazer', callback_data: 'undo' }
            ]]
        }
    });
}


// ==============================
// ⌨️ TECLADO DE CATEGORIAS DINÂMICO
// ==============================
async function gerarTecladoCategorias() {
    // 1. Categorias padrão (hardcoded)
    const defaultCatsArr = [
        { nome: 'alimentação', emoji: '🍔' },
        { nome: 'combustível', emoji: '⛽' },
        { nome: 'farmácia', emoji: '💊' },
        { nome: 'vestuário', emoji: '👕' },
        { nome: 'mercado', emoji: '🛒' },
        { nome: 'lazer', emoji: '🎮' },
        { nome: 'transporte', emoji: '🚗' },
        { nome: 'contas', emoji: '🏠' }
    ];
    const defaultLower = new Set(defaultCatsArr.map(c => c.nome.toLowerCase()));

    // 2. Categorias explicitamente criadas (na tabela categorias)
    const { data: catData } = await supabase.from('categorias').select('nome, emoji');
    const customValid = (catData || []).filter(c => !defaultLower.has(c.nome.toLowerCase().trim()));
    const customLower = new Set(customValid.map(c => c.nome.toLowerCase().trim()));

    // 3. Categorias que aparecem nas transações (aprendidas)
    const { data: txData } = await supabase.from('transactions').select('categoria');
    const txCatsUnicos = [...new Set((txData || []).map(t => t.categoria?.toLowerCase().trim()).filter(Boolean))];

    // Montagem do teclado
    const menus = [];

    // Adiciona padrões
    defaultCatsArr.forEach(c => {
        menus.push({ text: `${c.emoji} ${c.nome.charAt(0).toUpperCase() + c.nome.slice(1)}`, callback_data: `cat_${c.nome}` });
    });

    // Adiciona customizadas (que não são padrões)
    customValid.forEach(c => {
        menus.push({ text: `${c.emoji || '📦'} ${c.nome}`, callback_data: `cat_${c.nome}` });
    });

    // Adiciona aprendidas (que não são nem padrão nem custom)
    txCatsUnicos.forEach(cat => {
        if (!defaultLower.has(cat) && !customLower.has(cat)) {
            menus.push({ text: `🤖 ${cat}`, callback_data: `cat_${cat}` });
        }
    });

    menus.push({ text: '✏️ Outra', callback_data: 'cat_outra' });

    const inline_keyboard = [];
    for (let i = 0; i < menus.length; i += 2) {
        inline_keyboard.push(menus.slice(i, i + 2));
    }
    return { inline_keyboard };
}


// ==============================
// 🤖 RECEBER MENSAGEM
// ==============================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const texto = msg.text;

    if (!texto) return;

    // Comandos
    if (texto.startsWith('/')) {
        return tratarComando(msg);
    }

    // Fluxo ativo
    if (estados[chatId]) {
        return tratarResposta(msg);
    }

    const dados = interpretarTexto(texto);

    // ❌ NÃO RECONHECEU
    if (dados.categoria === 'outros') {
        estados[chatId] = { etapa: 'escolher_categoria', dados };

        const teclado = await gerarTecladoCategorias();
        return bot.sendMessage(chatId,
            `Não reconheci a categoria 🤔\n\nEscolha uma:`,
            { reply_markup: teclado }
        );
    }

    // ✅ CONFIRMAÇÃO
    estados[chatId] = { etapa: 'confirmacao', dados };

    bot.sendMessage(chatId,
        `Confere isso?\n\n💰 R$${dados.valor}\n📂 ${dados.categoria}\n📋 ${dados.descricao}\n📅 ${dados.data_label}`,
        {
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Confirmar', callback_data: 'confirmar' },
                    { text: '✏️ Editar', callback_data: 'editar' },
                    { text: '❌ Cancelar', callback_data: 'cancelar' }
                ]]
            }
        }
    );
});


// ==============================
// 🎙️ MENSAGENS DE ÁUDIO (WHISPER)
// ==============================
bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;

    // Verificar se a API Key está configurada
    if (OPENAI_KEY === 'SUA_OPENAI_API_KEY_AQUI') {
        return bot.sendMessage(chatId,
            '⚠️ A transcrição de áudio ainda não está configurada.\nPeça ao administrador para configurar a chave da OpenAI.'
        );
    }

    const statusMsg = await bot.sendMessage(chatId, '🎙️ Transcrevendo áudio…');

    try {
        // 1. Obter URL do arquivo no Telegram
        const fileId = msg.voice.file_id;
        const fileInfo = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

        // 2. Baixar o arquivo para um temp path
        const tmpPath = path.join(__dirname, `voice_${chatId}_${Date.now()}.ogg`);
        await baixarArquivo(fileUrl, tmpPath);

        // 3. Transcrever com Whisper
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tmpPath),
            model: 'whisper-1',
            language: 'pt',
        });

        // 4. Limpar arquivo temporário
        fs.unlink(tmpPath, () => { });

        const textoTranscrito = transcription.text?.trim();

        if (!textoTranscrito) {
            return bot.editMessageText('❌ Não consegui entender o áudio.', {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });
        }

        // 5. Mostrar o que foi transcrito
        await bot.editMessageText(`🎙️ *"${textoTranscrito}"*\n\nProcessando…`, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        });

        // 6. Processar exatamente como uma mensagem de texto
        const msgFake = { ...msg, text: textoTranscrito };

        // Verificar se existe fluxo ativo
        if (estados[chatId]) {
            return tratarResposta(msgFake);
        }

        const dados = interpretarTexto(textoTranscrito);

        if (dados.categoria === 'outros') {
            estados[chatId] = { etapa: 'escolher_categoria', dados };
            const teclado = await gerarTecladoCategorias();
            return bot.sendMessage(chatId,
                `Não reconheci a categoria 🤔\n\nEscolha uma:`,
                { reply_markup: teclado }
            );
        }

        // ✅ Confirmação
        estados[chatId] = { etapa: 'confirmacao', dados };
        bot.sendMessage(chatId,
            `Confere isso?\n\n💰 R$${dados.valor}\n📂 ${dados.categoria}\n📋 ${dados.descricao}\n📅 ${dados.data_label}`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Confirmar', callback_data: 'confirmar' },
                        { text: '✏️ Editar', callback_data: 'editar' },
                        { text: '❌ Cancelar', callback_data: 'cancelar' }
                    ]]
                }
            }
        );

    } catch (err) {
        console.error('ERRO WHISPER:', err);
        bot.editMessageText('❌ Erro ao transcrever áudio: ' + err.message, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        }).catch(() => bot.sendMessage(chatId, '❌ Erro ao transcrever áudio.'));
    }
});


// ==============================
// 📥 BAIXAR ARQUIVO (helper)
// ==============================
function baixarArquivo(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (res) => {
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => {
            fs.unlink(destPath, () => { });
            reject(err);
        });
    });
}


// ==============================
// 🔘 CALLBACK BUTTONS
// ==============================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const estado = estados[chatId];

    bot.answerCallbackQuery(query.id).catch(() => { });

    // =========================
    // UNDO
    // =========================
    if (data === 'undo') {
        const pending = pendingUndo[chatId];
        if (!pending) {
            return bot.sendMessage(chatId, '⏱️ Tempo de desfazer expirou.');
        }

        clearTimeout(pending.timeout);
        const txId = pending.id;
        delete pendingUndo[chatId];

        const { error } = await supabase
            .from('transactions')
            .delete()
            .eq('id', txId);

        if (error) {
            console.log('ERRO UNDO:', error);
            return bot.sendMessage(chatId, '❌ Não consegui desfazer.');
        }

        return bot.sendMessage(chatId, '↩️ Gasto desfeito!');
    }

    // =========================
    // ESCOLHER CATEGORIA
    // =========================
    if (data.startsWith('cat_')) {
        if (!estado) return;

        const categoria = data.replace('cat_', '');

        if (categoria === 'outra') {
            estado.etapa = 'digitar_categoria';
            return bot.sendMessage(chatId, 'Digite a nova categoria:');
        }

        estado.dados.categoria = categoria;

        // Aprender alias
        const palavras = normalizarTexto(estado.dados.descricao).split(' ');
        const palavraChave = palavras.filter(p => p.length > 2).pop() || palavras[palavras.length - 1];

        const { error: errAlias } = await supabase
            .from('aliases')
            .insert([{ palavra: palavraChave, categoria }]);

        if (!errAlias) {
            aliasesDB[palavraChave] = categoria;
        } else {
            console.log('ERRO ALIAS:', errAlias);
        }

        const tx = await salvarTransacao(chatId, estado.dados);
        delete estados[chatId];

        if (tx) {
            oferecerUndo(chatId, tx.id, `✅ Salvo como *${categoria}* e aprendido!`);
        }
        return;
    }

    // =========================
    // CANCELAR
    // =========================
    if (data === 'cancelar') {
        if (!estado) return;
        delete estados[chatId];
        return bot.editMessageText('❌ Operação cancelada.', {
            chat_id: chatId,
            message_id: query.message.message_id
        });
    }

    // =========================
    // CONFIRMAR
    // =========================
    if (data === 'confirmar') {
        if (!estado) return;

        const tx = await salvarTransacao(chatId, estado.dados);
        delete estados[chatId];

        if (tx) {
            oferecerUndo(chatId, tx.id, '✅ Salvo!');
        }
        return;
    }

    // =========================
    // EDITAR
    // =========================
    if (data === 'editar') {
        if (!estado) return;

        estado.etapa = 'editar_valor';
        return bot.sendMessage(chatId, 'Digite o novo valor (ex: 45,90):');
    }

    // =========================
    // DELETAR (de /ultimos)
    // =========================
    if (data.startsWith('del_')) {
        const txId = parseInt(data.replace('del_', ''));
        const { error } = await supabase.from('transactions').delete().eq('id', txId);

        if (error) {
            console.log('ERRO DELETE:', error);
            return bot.sendMessage(chatId, '❌ Erro ao deletar.');
        }
        return bot.sendMessage(chatId, '🗑️ Deletado!');
    }
});


// ==============================
// 🔄 TRATAMENTO DE RESPOSTAS
// ==============================
async function tratarResposta(msg) {
    const chatId = msg.chat.id;
    const texto = msg.text;
    const estado = estados[chatId];

    if (!estado) return;

    // Digitar nova categoria (livre)
    if (estado.etapa === 'digitar_categoria') {
        const categoria = normalizarTexto(texto);
        estado.dados.categoria = categoria;

        const palavras = normalizarTexto(estado.dados.descricao).split(' ');
        const palavraChave = palavras.filter(p => p.length > 2).pop() || palavras[palavras.length - 1];

        const { error: errAlias } = await supabase
            .from('aliases')
            .insert([{ palavra: palavraChave, categoria }]);

        if (!errAlias) {
            aliasesDB[palavraChave] = categoria;
        }

        const tx = await salvarTransacao(chatId, estado.dados);
        delete estados[chatId];

        if (tx) {
            oferecerUndo(chatId, tx.id, `✅ Salvo como *${categoria}* e aprendido!`);
        }
        return;
    }

    // Editar valor
    if (estado.etapa === 'editar_valor') {
        const novo = parseFloat(texto.replace(',', '.'));
        if (isNaN(novo)) {
            return bot.sendMessage(chatId, '❌ Valor inválido. Use números, ex: 45,90');
        }
        estado.dados.valor = novo;
        estado.etapa = 'editar_categoria';
        return bot.sendMessage(chatId, 'Digite a categoria (ou "manter" para manter a atual):');
    }

    // Editar categoria
    if (estado.etapa === 'editar_categoria') {
        if (texto.toLowerCase() !== 'manter') {
            estado.dados.categoria = normalizarTexto(texto);
        }

        const tx = await salvarTransacao(chatId, estado.dados);
        delete estados[chatId];

        if (tx) {
            oferecerUndo(chatId, tx.id, '✅ Salvo com os novos dados!');
        }
        return;
    }
}


// ==============================
// 🕹️ COMANDOS
// ==============================
async function tratarComando(msg) {
    const chatId = msg.chat.id;
    const texto = msg.text.trim();

    // ─── /resumo ───────────────────────────────────────────────
    if (texto === '/resumo') {
        const agora = new Date();
        const inicio = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString();
        const fim = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59).toISOString();

        const { data, error } = await supabase
            .from('transactions')
            .select('valor, categoria')
            .gte('created_at', inicio)
            .lte('created_at', fim);

        if (error || !data || data.length === 0) {
            return bot.sendMessage(chatId, '📭 Nenhum gasto registrado este mês.');
        }

        const agrupado = {};
        let total = 0;
        data.forEach(t => {
            if (!agrupado[t.categoria]) agrupado[t.categoria] = 0;
            agrupado[t.categoria] += t.valor;
            total += t.valor;
        });

        const emojis = {
            'alimentação': '🍔', 'combustível': '⛽', 'farmácia': '💊',
            'vestuário': '👕', 'mercado': '🛒', 'lazer': '🎮',
            'transporte': '🚗', 'contas': '🏠', 'outros': '📦'
        };

        const linhas = Object.entries(agrupado)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, val]) => `${emojis[cat] || '📦'} *${cat}*: R$ ${val.toFixed(2)}`)
            .join('\n');

        return bot.sendMessage(chatId,
            `📊 *Resumo do mês*\n\n${linhas}\n\n💰 *Total: R$ ${total.toFixed(2)}*`,
            { parse_mode: 'Markdown' }
        );
    }

    // ─── /ultimos ──────────────────────────────────────────────
    if (texto === '/ultimos') {
        const { data, error } = await supabase
            .from('transactions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(5);

        if (error || !data || data.length === 0) {
            return bot.sendMessage(chatId, '📭 Nenhum gasto encontrado.');
        }

        const botoes = data.map(t => ([{
            text: `🗑️ R$${t.valor} — ${t.categoria}`,
            callback_data: `del_${t.id}`
        }]));

        const lista = data.map((t, i) => {
            const d = new Date(t.created_at).toLocaleDateString('pt-BR');
            return `${i + 1}. *${t.categoria}* — R$ ${t.valor.toFixed(2)}\n   📋 ${t.descricao || '—'} • 📅 ${d}`;
        }).join('\n\n');

        return bot.sendMessage(chatId,
            `🧾 *Últimos 5 gastos*\n\n${lista}\n\nClique para deletar:`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: botoes }
            }
        );
    }

    // ─── /meta ─────────────────────────────────────────────────
    if (texto.startsWith('/meta ')) {
        // Uso: /meta alimentação 500
        const partes = texto.split(' ').filter(Boolean);
        if (partes.length < 3) {
            return bot.sendMessage(chatId, '❓ Uso correto: /meta [categoria] [valor]\nEx: /meta alimentação 500');
        }

        const categoria = normalizarTexto(partes[1]);
        const valor = parseFloat(partes[2].replace(',', '.'));

        if (isNaN(valor) || valor <= 0) {
            return bot.sendMessage(chatId, '❌ Valor inválido.');
        }

        // Upsert
        const { data: existing } = await supabase
            .from('metas')
            .select('id')
            .eq('categoria', categoria)
            .single();

        let error;
        if (existing) {
            ({ error } = await supabase.from('metas').update({ valor }).eq('id', existing.id));
        } else {
            ({ error } = await supabase.from('metas').insert([{ categoria, valor }]));
        }

        if (error) {
            console.log('ERRO META:', error);
            return bot.sendMessage(chatId, '❌ Erro ao salvar meta.');
        }

        return bot.sendMessage(chatId, `🎯 Meta de *${categoria}* definida: R$ ${valor.toFixed(2)}`, { parse_mode: 'Markdown' });
    }

    // ─── /ajuda / /start ───────────────────────────────────────
    if (texto === '/ajuda' || texto === '/start') {
        return bot.sendMessage(chatId,
            `👋 *Olá! Sou o Finn*\n\nRegistre gastos em texto ou por áudio:\n_"gastei 45 no almoço"_\n_"paguei 80 de gasolina ontem"_\n🎙️ *Ou envie um áudio — eu transcrevo automático!*\n\n📌 *Comandos disponíveis:*\n/resumo — Total do mês por categoria\n/ultimos — Últimos 5 gastos\n/meta [categoria] [valor] — Define uma meta\n/ajuda — Mostra esta mensagem`,
            { parse_mode: 'Markdown' }
        );
    }
}