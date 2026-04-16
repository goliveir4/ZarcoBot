const axios = require('axios');
const pool = require('./database');

// ─── Configuração ────────────────────────────────────────────────────────────
const CONFIG = {
    baseUrl: 'https://onibus.info/api',
    timeoutMs: 10_000,
    delayEntreLinhasMs: 1_000,
    maxTentativas: 3,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://onibus.info/',
    },
};

// ─── Utilitários ─────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normaliza horas >= 24 que algumas APIs usam (ex: 25:30 → 01:30). */
function normalizarHora(hora) {
    const [h, m] = hora.split(':');
    const hNorm = parseInt(h, 10) % 24;
    return `${String(hNorm).padStart(2, '0')}:${m}:00`;
}

/**
 * Faz uma requisição GET com retry e backoff exponencial.
 * Tenta até CONFIG.maxTentativas vezes antes de lançar o erro.
 */
async function httpGet(url) {
    let ultimoErro;

    for (let tentativa = 1; tentativa <= CONFIG.maxTentativas; tentativa++) {
        try {
            const res = await axios.get(url, {
                headers: CONFIG.headers,
                timeout: CONFIG.timeoutMs,
            });
            return res.data;
        } catch (erro) {
            ultimoErro = erro;
            const status = erro.response?.status;

            // 404 não vale tentar de novo
            if (status === 404) throw erro;

            const espera = 2 ** tentativa * 1000; // 2s, 4s, 8s
            console.warn(`   ⚠️  Tentativa ${tentativa}/${CONFIG.maxTentativas} falhou (${status ?? 'timeout'}). Aguardando ${espera / 1000}s...`);
            await delay(espera);
        }
    }

    throw ultimoErro;
}

// ─── Extração de dados da API ─────────────────────────────────────────────────

/** Busca e retorna a lista de números de linha da API. */
async function buscarLinhasDaApi() {
    const dados = await httpGet(`${CONFIG.baseUrl}/routes/group`);

    // Percorre a estrutura procurando campos que parecem número de linha
    const linhas = new Set();

    function extrairRecursivo(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            obj.forEach(extrairRecursivo);
            return;
        }
        // Campos conhecidos que carregam o número da linha
        for (const campo of ['id', 'route_id', 'name', 'number']) {
            const val = obj[campo];
            if (typeof val === 'string' && /^\d{3,4}$/.test(val.trim())) {
                linhas.add(val.trim());
            }
        }
        Object.values(obj).forEach(extrairRecursivo);
    }

    extrairRecursivo(dados);
    return [...linhas].sort();
}

/** Busca os dados de horários de uma linha específica. */
async function buscarHorariosDaApi(numeroLinha) {
    return httpGet(`${CONFIG.baseUrl}/timetable/${numeroLinha}`);
}

// ─── Persistência no banco ────────────────────────────────────────────────────

/**
 * UPSERT de linha — insere ou retorna o ID existente.
 * Usa ON CONFLICT para evitar SELECT + INSERT separados.
 */
async function upsertLinha(client, numero) {
    const res = await client.query(
        `INSERT INTO linhas (numero, nome)
         VALUES ($1, $2)
         ON CONFLICT (numero) DO UPDATE SET numero = EXCLUDED.numero
         RETURNING id`,
        [numero, `Linha ${numero}`]
    );
    return res.rows[0].id;
}

/**
 * UPSERT de terminal — insere ou retorna o ID existente.
 */
async function upsertTerminal(client, nome) {
    const res = await client.query(
        `INSERT INTO terminais (nome)
         VALUES ($1)
         ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
         RETURNING id`,
        [nome]
    );
    return res.rows[0].id;
}

/**
 * Bulk insert de horários com ON CONFLICT DO NOTHING.
 * Requer UNIQUE CONSTRAINT em (id_linha, id_terminal_saida, tipo_dia, hora_saida).
 *
 * Exemplo de migration para criar a constraint:
 *   ALTER TABLE horarios ADD CONSTRAINT horarios_unique
 *   UNIQUE (id_linha, id_terminal_saida, tipo_dia, hora_saida);
 */
async function inserirHorarios(client, registros) {
    if (registros.length === 0) return 0;

    // Monta os placeholders dinamicamente: ($1,$2,$3,$4), ($5,$6,$7,$8), ...
    const valores = [];
    const placeholders = registros.map((r, i) => {
        const base = i * 4;
        valores.push(r.idLinha, r.idTerminal, r.tipoDia, r.hora);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });

    const res = await client.query(
        `INSERT INTO horarios (id_linha, id_terminal_saida, tipo_dia, hora_saida)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT DO NOTHING`,
        valores
    );
    return res.rowCount;
}

// ─── Processamento de uma linha ───────────────────────────────────────────────

/**
 * Processa todos os dados de uma linha dentro de uma transação.
 * Se qualquer coisa falhar, o ROLLBACK garante que nada parcial fica no banco.
 */
async function processarLinha(numeroLinha) {
    const dadosJson = await buscarHorariosDaApi(numeroLinha);
    const direcoes = Array.isArray(dadosJson) ? dadosJson : [dadosJson];

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        const idLinha = await upsertLinha(dbClient, numeroLinha);
        let totalInseridos = 0;

        for (const direcao of direcoes) {
            if (!direcao.stop_data?.length) continue;

            // Acha o primeiro ponto com horários cadastrados
            const pontoComHorarios = direcao.stop_data.find(
                (p) => p.service_data?.length > 0
            );
            if (!pontoComHorarios) continue;

            const nomeTerminal = pontoComHorarios.stop_name.trim();
            const idTerminal = await upsertTerminal(dbClient, nomeTerminal);

            for (const servico of pontoComHorarios.service_data) {
                const tipoDia = servico.service_name;

                // time_data é um array de arrays — achata e extrai departure_time de cada objeto
                const horariosRaw = (servico.time_data ?? [])
                    .flat()
                    .map((t) => t?.departure_time)
                    .filter((v) => typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v));

                const horariosUnicos = [...new Set(horariosRaw)].sort();

                const registros = horariosUnicos.map((hora) => ({
                    idLinha,
                    idTerminal,
                    tipoDia,
                    hora: normalizarHora(hora),
                }));

                const inseridos = await inserirHorarios(dbClient, registros);
                totalInseridos += inseridos;
            }
        }

        await dbClient.query('COMMIT');
        return totalInseridos;

    } catch (erro) {
        await dbClient.query('ROLLBACK');
        throw erro;
    } finally {
        dbClient.release();
    }
}

// ─── Orquestrador principal ───────────────────────────────────────────────────

async function rasparTudo() {
    console.log('🤖 Iniciando o scraper...\n');

    try {
        console.log('📡 Buscando lista de linhas...');
        const linhas = await buscarLinhasDaApi();
        const total = linhas.length;
        console.log(`✅ ${total} linhas encontradas. Iniciando varredura...\n`);

        const inicio = Date.now();
        let processadas = 0;
        let falhas = 0;

        for (const numeroLinha of linhas) {
            processadas++;
            const decorrido = ((Date.now() - inicio) / 1000).toFixed(0);
            const porLinhaMs = (Date.now() - inicio) / processadas;
            const restanteMin = (((total - processadas) * porLinhaMs) / 60_000).toFixed(1);

            process.stdout.write(
                `[${processadas}/${total}] Linha ${numeroLinha} | ${decorrido}s decorridos | ~${restanteMin}min restantes... `
            );

            try {
                const inseridos = await processarLinha(numeroLinha);
                console.log(`✅ ${inseridos} horários salvos.`);
            } catch (erro) {
                falhas++;
                if (erro.response?.status === 404) {
                    console.log('⚠️  Não encontrada na API. Pulando.');
                } else {
                    console.log(`❌ Erro: ${erro.message}`);
                }
            }

            await delay(CONFIG.delayEntreLinhasMs);
        }

        const totalSegundos = ((Date.now() - inicio) / 1000).toFixed(1);
        console.log(`\n🏁 Concluído em ${totalSegundos}s — ${processadas - falhas} linhas ok, ${falhas} falhas.`);

    } catch (erro) {
        console.error('\n❌ Erro fatal:', erro.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

rasparTudo();