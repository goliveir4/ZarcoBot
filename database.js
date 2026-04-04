const { Pool } = require('pg');

// Configuração da conexão
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'zarcobot_db',
    password: '2402', 
    port: 5432,
});

// Exporta a conexão para que outros arquivos possam usar
module.exports = pool;