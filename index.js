const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const pool = require('./database');

const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    console.log('📱 Escaneie o QR Code abaixo com o seu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ ZarcoBot Inteligente está online e conectado ao Banco!');
});

// A "memória" do bot para saber em qual passo o usuário está
const estadoConversa = {};

client.on('message', async (message) => {
    const texto = message.body.toLowerCase().trim();
    const numeroUsuario = message.from;

    // Se o usuário mandar oi, menu, ou se não tiver conversa iniciada
    if (texto === 'menu' || texto === 'oi' || texto === 'ola' || texto === 'olá') {
        estadoConversa[numeroUsuario] = { passo: 'aguardando_linha' };
        await message.reply('Olá! Sou o *ZarcoBot* 🚌\n\nQual o *número da linha* que você deseja consultar? (ex: 0100, 0223, 0040)');
        return;
    }

    // Se ele não mandou "oi", mas o bot está esperando ele digitar a linha
    if (!estadoConversa[numeroUsuario] || estadoConversa[numeroUsuario].passo === 'aguardando_linha') {
        const linhaDigitada = texto; // Presumimos que o que ele digitou é a linha

        try {
            // Busca QUAIS terminais/ruas têm essa linha cadastrada
            const resOrigens = await pool.query(`
                SELECT DISTINCT t.id, t.nome 
                FROM horarios h
                JOIN terminais t ON h.id_terminal_saida = t.id
                JOIN linhas l ON h.id_linha = l.id
                WHERE l.numero = $1
            `, [linhaDigitada]);

            if (resOrigens.rows.length === 0) {
                await message.reply(`Poxa, não encontrei a linha *${linhaDigitada}* no meu sistema.\n\nVerifique se o número está correto e digite novamente, ou mande *menu* para recomeçar.`);
                return;
            }

            // Monta o menu dinâmico com as opções de Ida e Volta
            let menuOrigens = `🚌 *Linha ${linhaDigitada}*\nDe onde você vai partir?\n\n*Responda com o número da opção:*\n`;
            const opcoesOrigem = {}; // Guarda o ID de cada opção para usar no próximo passo
            
            resOrigens.rows.forEach((origem, index) => {
                const numOpcao = index + 1;
                menuOrigens += `\n*${numOpcao}* - ${origem.nome}`;
                opcoesOrigem[numOpcao] = origem.id; 
            });

            await message.reply(menuOrigens);

            // Avança o passo e guarda as opções na memória
            estadoConversa[numeroUsuario] = { 
                passo: 'aguardando_origem', 
                linha: linhaDigitada,
                opcoes: opcoesOrigem 
            };

        } catch (erro) {
            console.error('Erro ao buscar origens:', erro);
            await message.reply('Ops, estou com problemas no banco de dados. 🔧');
        }
        return;
    }

    // Se o bot está esperando ele escolher entre Ida e Volta (1, 2, etc.)
    if (estadoConversa[numeroUsuario].passo === 'aguardando_origem') {
        const opcaoEscolhida = parseInt(texto);
        const estado = estadoConversa[numeroUsuario]; // Recupera a memória

        // Verifica se ele digitou um número válido do menu
        if (estado.opcoes[opcaoEscolhida]) {
            const idTerminalEscolhido = estado.opcoes[opcaoEscolhida];
            
            try {
                // Pega a hora atual do seu celular/computador
                const agora = new Date();
                const horaAtual = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }); 

                // Busca os horários do FUTURO
                const resHorarios = await pool.query(`
                    SELECT h.hora_saida, t.nome as nome_terminal
                    FROM horarios h
                    JOIN terminais t ON h.id_terminal_saida = t.id
                    JOIN linhas l ON h.id_linha = l.id
                    WHERE l.numero = $1 
                      AND t.id = $2
                      AND h.tipo_dia = 'Dias Úteis' 
                      AND h.hora_saida >= $3
                    ORDER BY h.hora_saida ASC
                    LIMIT 5
                `, [estado.linha, idTerminalEscolhido, horaAtual]);

                if (resHorarios.rows.length > 0) {
                    const nomeTerminal = resHorarios.rows[0].nome_terminal;
                    let resposta = `🚌 *Próximos ônibus - Linha ${estado.linha}*\n📍 Saindo de: *${nomeTerminal}*\n\n`;
                    
                    resHorarios.rows.forEach(linha => {
                        resposta += `⏰ ${linha.hora_saida.substring(0, 5)}\n`; // Corta os segundos
                    });
                    
                    resposta += '\nDigite *menu* para fazer uma nova consulta.';
                    await message.reply(resposta);
                    
                    // Reseta a conversa
                    estadoConversa[numeroUsuario] = { passo: 'aguardando_linha' };
                } else {
                    await message.reply(`A operação desta linha saindo deste ponto já encerrou por hoje.\n\nDigite *menu* para pesquisar outra linha.`);
                    estadoConversa[numeroUsuario] = { passo: 'aguardando_linha' };
                }

            } catch (erro) {
                console.error('Erro ao buscar horários:', erro);
                await message.reply('Ops, deu um erro ao buscar os horários. 🔧');
            }
        } else {
            await message.reply('Opção inválida. Por favor, digite apenas o *número* que aparece no menu acima.');
        }
        return;
    }
});

client.initialize();