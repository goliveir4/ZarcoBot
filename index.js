const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const pool = require('./database'); // Conexão com o PostgreSQL

const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    console.log('Escaneie o QR Code abaixo com o seu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ ZarcoBot está online e conectado ao Banco de Dados!');
});

const terminais = [
    "1️⃣ Centro", "2️⃣ Norte", "3️⃣ Sul", "4️⃣ Itaum", 
    "5️⃣ Tupy", "6️⃣ Pirabeiraba", "7️⃣ Vila Nova", 
    "8️⃣ Nova Brasília", "9️⃣ Guanabara", "🔟 Iririú"
];

// O estado agora é um objeto que guarda o passo atual e os dados temporários
const estadoConversa = {};

client.on('message', async (message) => {
    const texto = message.body.toLowerCase().trim();
    const numeroUsuario = message.from;

    // Se o usuário não tem estado, iniciamos um
    if (!estadoConversa[numeroUsuario]) {
        estadoConversa[numeroUsuario] = { passo: 'inicio' };
    }

    // 1. FAST TRACK (Acesso rápido)
    if (texto.includes('horários') && texto.includes('0100')) {
        try {
            const res = await pool.query(`
                SELECT h.hora_saida 
                FROM horarios h
                JOIN linhas l ON h.id_linha = l.id
                JOIN terminais t ON h.id_terminal_saida = t.id
                WHERE l.numero = '0100' AND t.nome = 'Norte'
                ORDER BY h.hora_saida ASC
                LIMIT 10
            `);

            if (res.rows.length > 0) {
                let resposta = '🚌 *Linha 0100 - Norte/Sul*\n\nPróximos horários saindo do Terminal Norte:\n';
                res.rows.forEach(linha => {
                    resposta += `⏰ ${linha.hora_saida.substring(0, 5)}\n`;
                });
                await message.reply(resposta);
            }
        } catch (erro) {
            console.error('Erro no fast track:', erro);
        }
        estadoConversa[numeroUsuario] = { passo: 'inicio' };
        return; 
    }

    // 2. FLUXO DE MENUS PASSO A PASSO
    if (texto === 'oi' || texto === 'olá' || texto === 'ola' || texto === 'menu') {
        let menuTerminais = 'Olá! Sou o *ZarcoBot* 🚌\nDe qual terminal você vai partir hoje?\n\n*Responda com o número da opção:*\n';
        terminais.forEach(t => menuTerminais += `\n${t}`);
        
        await message.reply(menuTerminais);
        
        // Define o passo
        estadoConversa[numeroUsuario] = { passo: 'aguardando_terminal' };
        return;
    }

    if (estadoConversa[numeroUsuario].passo === 'aguardando_terminal') {
        const opcaoEscolhida = parseInt(texto);

        if (opcaoEscolhida >= 1 && opcaoEscolhida <= 10) {
            const terminalEscolhido = terminais[opcaoEscolhida - 1].split(' ')[1]; 
            
            await message.reply(`Ótima escolha! Você está no *Terminal ${terminalEscolhido}*.\n\nPara qual linha você quer ir? Digite o número da rota (ex: 0100, 0041).`);
            
            // Avança o passo e SALVA o terminal na memória do bot
            estadoConversa[numeroUsuario] = { 
                passo: 'aguardando_linha', 
                terminalOrigem: terminalEscolhido 
            };
        } else {
            await message.reply('Opção inválida. Por favor, digite um número de *1 a 10*.');
        }
        return;
    }

    if (estadoConversa[numeroUsuario].passo === 'aguardando_linha') {
        const linhaDigitada = texto; // O que o usuário digitou (ex: '0041')
        const terminalSalvo = estadoConversa[numeroUsuario].terminalOrigem; // O que ele escolheu no passo anterior

        try {
            // Consulta REAL no banco unindo a linha e o terminal
            const res = await pool.query(`
                SELECT h.hora_saida 
                FROM horarios h
                JOIN linhas l ON h.id_linha = l.id
                JOIN terminais t ON h.id_terminal_saida = t.id
                WHERE l.numero = $1 AND t.nome = $2
                ORDER BY h.hora_saida ASC
                LIMIT 10
            `, [linhaDigitada, terminalSalvo]);

            if (res.rows.length > 0) {
                let resposta = `🚌 *Linha ${linhaDigitada} - Saindo do Terminal ${terminalSalvo}*\n\nPróximos horários cadastrados:\n`;
                
                res.rows.forEach(linha => {
                    const horaFormatada = linha.hora_saida.substring(0, 5); 
                    resposta += `⏰ ${horaFormatada}\n`;
                });
                
                resposta += '\nDigite *menu* para fazer uma nova consulta.';
                await message.reply(resposta);
                
                // Só reseta para o início se deu sucesso
                estadoConversa[numeroUsuario] = { passo: 'inicio' };
            } else {
                await message.reply(`Poxa, não encontrei horários para a linha *${linhaDigitada}* saindo do terminal *${terminalSalvo}*.\n\nVerifique se o número está correto e digite novamente, ou digite *menu* para recomeçar.`);
                // Não reseta o estado aqui, permite que ele tente digitar outro número de linha
            }

        } catch (erro) {
            console.error('Erro no banco de dados:', erro);
            await message.reply('Desculpe, estou com problemas técnicos para acessar o banco de dados agora. 🔧');
            estadoConversa[numeroUsuario] = { passo: 'inicio' };
        }
        return;
    }
});

client.initialize();