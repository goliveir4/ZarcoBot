const pool = require('./database');

async function teste() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r1 = await client.query(
      `INSERT INTO linhas (numero, nome) VALUES ('0100', 'Linha 0100')
       ON CONFLICT (numero) DO UPDATE SET numero = EXCLUDED.numero
       RETURNING id`
    );
    const idLinha = r1.rows[0].id;
    console.log('idLinha:', idLinha);

    const r2 = await client.query(
      `INSERT INTO terminais (nome) VALUES ('Terminal Teste')
       ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
       RETURNING id`
    );
    const idTerminal = r2.rows[0].id;
    console.log('idTerminal:', idTerminal);

    const r3 = await client.query(
      `INSERT INTO horarios (id_linha, id_terminal_saida, tipo_dia, hora_saida)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [idLinha, idTerminal, 'Dias Úteis', '04:25:00']
    );
    console.log('horario inserido:', r3.rows);

    await client.query('COMMIT');
    console.log('COMMIT ok');
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('ERRO:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

teste();