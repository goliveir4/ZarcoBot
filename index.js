const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const pool = require('./database');

// ─── Constantes de texto ────────────────────────────────────────────────────
const MENSAGENS = {
    boasVindas: 'Olá! Sou o *ZarcoBot* 🚌\n\nQual o *número da linha* que você deseja consultar? (ex: 0100, 0223, 0040)',
    linhaNaoEncontrada: (linha) =>
        `Poxa, não encontrei a linha *${linha}* no meu sistema.\n\nVerifique se o número está correto e tente novamente, ou mande *menu* para recomeçar.`,
    opcaoInvalida: 'Opção inválida. Por favor, digite apenas o *número* que aparece no menu acima.',
    operacaoEncerrada: 'A operação desta linha saindo deste ponto já encerrou por hoje.\n\nDigite *menu* para pesquisar outra linha.',
    sessaoExpirada: 'Sua sessão expirou por inatividade. Mande *menu* para recomeçar.',
    erroDb: 'Ops, estou com problemas no banco de dados. Tente novamente em instantes. 🔧',
    novaConsulta: '\n\nDigite *menu* para fazer uma nova consulta.',
};

// ─── Gerenciamento de estado com expiração automática ───────────────────────
const TIMEOUT_SESSAO_MS = 5 * 60 * 1000; // 5 minutos
const estadoConversa = new Map();

function getEstado(numero) {
    return estadoConversa.get(numero) ?? null;
}

function setEstado(numero, dados) {
    const estadoAtual = estadoConversa.get(numero);

    // Cancela o timeout anterior, se existir
    if (estadoAtual?._timeout) {
        clearTimeout(estadoAtual._timeout);
    }

    const _timeout = setTimeout(async () => {
        estadoConversa.delete(numero);
        try {
            const client = getClient();
            await client.sendMessage(numero, MENSAGENS.sessaoExpirada);
        } catch (_) {
            // ignora erro ao notificar sessão expirada
        }
    }, TIMEOUT_SESSAO_MS);

    estadoConversa.set(numero, { ...dados, _timeout });
}

function limparEstado(numero) {
    const estado = estadoConversa.get(numero);
    if (estado?._timeout) clearTimeout(estado._timeout);
    estadoConversa.delete(numero);
}

// ─── Utilitários ─────────────────────────────────────────────────────────────

/** Retorna a hora atual no fuso de São Paulo (HH:MM:SS). */
function horaAtualSP() {
    return new Date().toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour12: false,
    });
}

/**
 * Retorna o tipo de dia correto para a query com base no dia da semana atual.
 * Ajuste os valores conforme os tipos cadastrados no seu banco.
 */
function tipoDiaAtual() {
    const diasSemana = [
        'Domingo/Feriado', // 0 - domingo
        'Dias Úteis',      // 1 - segunda
        'Dias Úteis',      // 2 - terça
        'Dias Úteis',      // 3 - quarta
        'Dias Úteis',      // 4 - quinta
        'Dias Úteis',      // 5 - sexta
        'Sábado',          // 6 - sábado
    ];
    const indice = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    ).getDay();
    return diasSemana[indice];
}

/** Valida se a entrada do usuário tem formato aceitável para número de linha. */
function linhaValida(texto) {
    return /^[a-zA-Z0-9]{2,6}$/.test(texto);
}

// ─── Queries ao banco ────────────────────────────────────────────────────────

async function buscarOrigens(linha) {
    const res = await pool.query(
        `SELECT DISTINCT t.id, t.nome
         FROM horarios h
         JOIN terminais t ON h.id_terminal_saida = t.id
         JOIN linhas l    ON h.id_linha = l.id
         WHERE l.numero = $1`,
        [linha]
    );
    return res.rows;
}

async function buscarProximosHorarios(linha, idTerminal) {
    const hora = horaAtualSP();
    const tipo = tipoDiaAtual();

    const res = await pool.query(
        `SELECT h.hora_saida, t.nome AS nome_terminal
         FROM horarios h
         JOIN terminais t ON h.id_terminal_saida = t.id
         JOIN linhas l    ON h.id_linha = l.id
         WHERE l.numero = $1
           AND t.id     = $2
           AND h.tipo_dia = $3
           AND h.hora_saida >= $4
         ORDER BY h.hora_saida ASC
         LIMIT 5`,
        [linha, idTerminal, tipo, hora]
    );
    return res.rows;
}

// ─── Formatadores de mensagem ────────────────────────────────────────────────

function formatarMenuOrigens(linha, origens) {
    let menu = `🚌 *Linha ${linha}*\nDe onde você vai partir?\n\n*Responda com o número da opção:*\n`;
    origens.forEach((origem, i) => {
        menu += `\n*${i + 1}* - ${origem.nome}`;
    });
    return menu;
}

function formatarHorarios(linha, horarios) {
    const nomeTerminal = horarios[0].nome_terminal;
    let resposta = `🚌 *Próximos ônibus - Linha ${linha}*\n📍 Saindo de: *${nomeTerminal}*\n\n`;
    horarios.forEach((h) => {
        resposta += `⏰ ${h.hora_saida.substring(0, 5)}\n`;
    });
    resposta += MENSAGENS.novaConsulta;
    return resposta;
}

// ─── Handlers de cada passo da conversa ─────────────────────────────────────

async function handleBoasVindas(message, numero) {
    setEstado(numero, { passo: 'aguardando_linha' });
    await message.reply(MENSAGENS.boasVindas);
}

async function handleAguardandoLinha(message, numero, texto) {
    if (!linhaValida(texto)) {
        await message.reply(
            'Por favor, digite apenas o *número da linha* (ex: 0100, 0223).'
        );
        return;
    }

    try {
        const origens = await buscarOrigens(texto);

        if (origens.length === 0) {
            await message.reply(MENSAGENS.linhaNaoEncontrada(texto));
            return;
        }

        const opcoes = {};
        origens.forEach((origem, i) => {
            opcoes[i + 1] = origem.id;
        });

        await message.reply(formatarMenuOrigens(texto, origens));

        setEstado(numero, {
            passo: 'aguardando_origem',
            linha: texto,
            opcoes,
        });
    } catch (erro) {
        console.error('[buscarOrigens] erro:', { numero, linha: texto, erro });
        await message.reply(MENSAGENS.erroDb);
    }
}

async function handleAguardandoOrigem(message, numero, texto) {
    const estado = getEstado(numero);
    const opcaoEscolhida = parseInt(texto, 10);

    if (!estado.opcoes[opcaoEscolhida]) {
        await message.reply(MENSAGENS.opcaoInvalida);
        return;
    }

    const idTerminal = estado.opcoes[opcaoEscolhida];

    try {
        const horarios = await buscarProximosHorarios(estado.linha, idTerminal);

        if (horarios.length > 0) {
            await message.reply(formatarHorarios(estado.linha, horarios));
        } else {
            await message.reply(MENSAGENS.operacaoEncerrada);
        }
    } catch (erro) {
        console.error('[buscarHorarios] erro:', {
            numero,
            linha: estado.linha,
            idTerminal,
            erro,
        });
        await message.reply(MENSAGENS.erroDb);
    } finally {
        limparEstado(numero);
    }
}

// ─── Cliente WhatsApp ─────────────────────────────────────────────────────────
let _clientInstance = null;

function getClient() {
    return _clientInstance;
}

const client = new Client({ authStrategy: new LocalAuth() });
_clientInstance = client;

client.on('qr', (qr) => {
    console.log('📱 Escaneie o QR Code abaixo com o seu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ ZarcoBot está online!');
});

client.on('message', async (message) => {
    // Ignora mensagens de grupos
    if (message.from.includes('@g.us')) return;

    // Ignora mensagens do próprio bot
    if (message.fromMe) return;

    const texto = message.body.toLowerCase().trim();
    const numero = message.from;
    const estado = getEstado(numero);

    // Palavras-chave que (re)iniciam o fluxo
    if (['menu', 'oi', 'ola', 'olá', 'início', 'inicio'].includes(texto)) {
        await handleBoasVindas(message, numero);
        return;
    }

    // Roteamento por passo
    const passo = estado?.passo ?? 'aguardando_linha';

    if (passo === 'aguardando_linha') {
        await handleAguardandoLinha(message, numero, texto);
        return;
    }

    if (passo === 'aguardando_origem') {
        await handleAguardandoOrigem(message, numero, texto);
        return;
    }
});

client.initialize();