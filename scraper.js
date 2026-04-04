const axios = require('axios');
const pool = require('./database');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function rasparTudo() {
    console.log('🤖 Iniciando o Robô Master de Captura...');

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
        const dadosRotas = respostaRotas.data;

        let linhasEncontradas = [];
        JSON.stringify(dadosRotas, (chave, valor) => {
            if ((chave === 'id' || chave === 'route_id' || chave === 'name') && typeof valor === 'string' && /^\d{3,4}$/.test(valor.trim())) {
                linhasEncontradas.push(valor.trim());
            }
            return valor;
        });

        linhasEncontradas = [...new Set(linhasEncontradas)].sort();

        console.log(`✅ Sucesso! Foram encontradas ${linhasEncontradas.length} linhas na cidade.`);
        
        if (linhasEncontradas.length === 0) return;

        console.log('🔄 Iniciando a varredura individual de horários...');
        
        const linhasParaRaspar = linhasEncontradas; 

        for (let numeroLinha of linhasParaRaspar) {
            console.log(`\n▶️ Analisando linha ${numeroLinha}...`);
            const apiUrl = `https://onibus.info/api/timetable/${numeroLinha}`;
            
            try {
                const respostaHorarios = await axios.get(apiUrl, configRobo);
                const horariosExtraidos = [];

                JSON.stringify(respostaHorarios.data, (chave, valor) => {
                    if (chave === 'departure_time') horariosExtraidos.push(valor);
                    return valor;
                });

                const horariosUnicos = [...new Set(horariosExtraidos)].sort();
                
                if (horariosUnicos.length > 0) {
                    console.log(`   Encontrados ${horariosUnicos.length} horários. Inserindo no banco...`);
                    
                    let resLinha = await pool.query(`SELECT id FROM linhas WHERE numero = $1`, [numeroLinha]);
                    let idLinha;
                    
                    if (resLinha.rows.length === 0) {
                        const novaLinha = await pool.query(
                            `INSERT INTO linhas (numero, nome) VALUES ($1, $2) RETURNING id`,
                            [numeroLinha, `Linha ${numeroLinha}`]
                        );
                        idLinha = novaLinha.rows[0].id;
                    } else {
                        idLinha = resLinha.rows[0].id;
                    }

                    for (let hora of horariosUnicos) {
                        // SOLUÇÃO DA MADRUGADA: Tratando horários 24:xx, 25:xx, etc.
                        let [h, m] = hora.split(':');
                        let hInt = parseInt(h);
                        
                        if (hInt >= 24) {
                            hInt = hInt - 24;
                            h = hInt.toString().padStart(2, '0'); // Garante que fique "00" ou "01"
                        }
                        
                        const horaFormatada = `${h}:${m}:00`; 

                        await pool.query(
                            `INSERT INTO horarios (id_linha, id_terminal_saida, tipo_dia, hora_saida) 
                             VALUES ($1, $2, $3, $4)`,
                            [idLinha, 1, 'Dia Útil', horaFormatada] 
                        );
                    }
                    console.log(`   ✅ Linha ${numeroLinha} salva com sucesso!`);
                } else {
                    console.log(`   ⚠️ Nenhum horário para a linha ${numeroLinha}.`);
                }

            } catch (erroLinha) {
                if (erroLinha.response && erroLinha.response.status === 404) {
                    console.log(`   ⚠️ Linha ${numeroLinha} não encontrada na API (Erro 404). Pulando...`);
                } else {
                    console.error(`   ❌ Erro ao buscar horários da linha ${numeroLinha}:`, erroLinha.message);
                }
            }

            console.log('   ⏳ Pausa de segurança...');
            await delay(1000); 
        }

    } catch (erro) {
        console.error('❌ Erro Fatal no Robô:', erro.message);
    } finally {
        await pool.end();
        console.log('\n🏁 Processo Finalizado. O banco está atualizado!');
    }
}

rasparTudo();