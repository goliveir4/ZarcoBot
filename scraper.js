const axios = require('axios');
const pool = require('./database');

// Função de pausa para evitar bloqueios do servidor
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function rasparTudo() {
    console.log('🤖 Iniciando o Robô (Versão Data-Driven: Origens Dinâmicas)...');

    try {
        const configRobo = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://onibus.info/' 
            }
        };

        console.log('📡 Buscando a lista mestre de linhas...');
        const respostaRotas = await axios.get('https://onibus.info/api/routes/group', configRobo);
        
        let linhasEncontradas = [];
        JSON.stringify(respostaRotas.data, (chave, valor) => {
            if ((chave === 'id' || chave === 'route_id' || chave === 'name') && typeof valor === 'string' && /^\d{3,4}$/.test(valor.trim())) {
                linhasEncontradas.push(valor.trim());
            }
            return valor;
        });

        linhasEncontradas = [...new Set(linhasEncontradas)].sort();
        console.log(`✅ ${linhasEncontradas.length} linhas encontradas. Iniciando varredura...\n`);

        for (let numeroLinha of linhasEncontradas) {
            console.log(`▶️ Analisando linha ${numeroLinha}...`);
            const apiUrl = `https://onibus.info/api/timetable/${numeroLinha}`;
            
            try {
                const respostaHorarios = await axios.get(apiUrl, configRobo);
                const dadosJson = respostaHorarios.data;

                // 1. Garante que a linha existe no banco
                let resLinha = await pool.query(`SELECT id FROM linhas WHERE numero = $1`, [numeroLinha]);
                let idLinha;
                if (resLinha.rows.length === 0) {
                    const novaLinha = await pool.query(`INSERT INTO linhas (numero, nome) VALUES ($1, $2) RETURNING id`, [numeroLinha, `Linha ${numeroLinha}`]);
                    idLinha = novaLinha.rows[0].id;
                } else {
                    idLinha = resLinha.rows[0].id;
                }

                let totalInseridos = 0;
                const listaDirecoes = Array.isArray(dadosJson) ? dadosJson : [dadosJson];

                for (let direcao of listaDirecoes) {
                    if (!direcao.stop_data || direcao.stop_data.length === 0) continue;

                    // PASSO 1: O Robô Farejador (Acha a gaveta de horários em qualquer ponto)
                    let pontoComHorarios = null;
                    for (let ponto of direcao.stop_data) {
                        if (ponto.service_data && ponto.service_data.length > 0) {
                            pontoComHorarios = ponto;
                            break; 
                        }
                    }

                    // Se a rota inteira não tem horários, ignoramos a direção.
                    if (!pontoComHorarios) continue;

                    // Pega o nome exato que a API forneceu
                    const nomeOrigemApi = pontoComHorarios.stop_name.trim();

                    // Verifica se esse nome de terminal/rua já existe no nosso banco
                    let resTerminal = await pool.query(`SELECT id FROM terminais WHERE nome = $1`, [nomeOrigemApi]);
                    let idTerminalOrigem;

                    if (resTerminal.rows.length === 0) {
                        // Se não existe, CADASTRA na hora!
                        const novoTerminal = await pool.query(
                            `INSERT INTO terminais (nome) VALUES ($1) RETURNING id`, 
                            [nomeOrigemApi]
                        );
                        idTerminalOrigem = novoTerminal.rows[0].id;
                    } else {
                        // Se já existe, só pega o ID
                        idTerminalOrigem = resTerminal.rows[0].id;
                    }

                    // PASSO 3: Extrair os dias da semana e salvar no banco
                    for (let servico of pontoComHorarios.service_data) {
                        const tipoDia = servico.service_name; 

                        let horariosDoDia = [];
                        JSON.stringify(servico, (chave, valor) => {
                            if (chave === 'departure_time') horariosDoDia.push(valor);
                            return valor;
                        });

                        const horariosUnicos = [...new Set(horariosDoDia)].sort();

                        for (let hora of horariosUnicos) {
                            let [h, m] = hora.split(':');
                            let hInt = parseInt(h);
                            if (hInt >= 24) {
                                hInt = hInt - 24;
                                h = hInt.toString().padStart(2, '0');
                            }
                            const horaFormatada = `${h}:${m}:00`; 

                            await pool.query(
                                `INSERT INTO horarios (id_linha, id_terminal_saida, tipo_dia, hora_saida) 
                                 VALUES ($1, $2, $3, $4)`,
                                [idLinha, idTerminalOrigem, tipoDia, horaFormatada] 
                            );
                            totalInseridos++;
                        }
                    }
                }

                console.log(`   ✅ ${totalInseridos} horários salvos.`);

            } catch (erroLinha) {
                if (erroLinha.response && erroLinha.response.status === 404) {
                    console.log(`   ⚠️ Linha não encontrada na API. Pulando...`);
                } else {
                    console.error(`   ❌ Erro na linha ${numeroLinha}:`, erroLinha.message);
                }
            }
            
            await delay(1000); 
        }

    } catch (erro) {
        console.error('❌ Erro Fatal no Robô:', erro.message);
    } finally {
        await pool.end();
        console.log('\n🏁 Banco atualizado e estruturado com sucesso (Data-Driven)!');
    }
}

rasparTudo();