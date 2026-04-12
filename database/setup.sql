-- 1. Criação das Tabelas
CREATE TABLE IF NOT EXISTS terminais (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS linhas (
    id SERIAL PRIMARY KEY,
    numero VARCHAR(10) NOT NULL,
    nome VARCHAR(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS horarios (
    id SERIAL PRIMARY KEY,
    id_linha INT REFERENCES linhas(id),
    id_terminal_saida INT REFERENCES terminais(id),
    tipo_dia VARCHAR(20) NOT NULL,
    hora_saida TIME NOT NULL
);

-- 2. Cadastro Inicial dos Terminais de Joinville
-- Importante: O robô (scraper) está usando o ID 1 para o Terminal Norte por padrão.
INSERT INTO terminais (nome) VALUES 
('Centro'), 
('Norte'), 
('Sul'), 
('Itaum'), 
('Tupy'), 
('Pirabeiraba'), 
('Vila Nova'), 
('Guanabara'), 
('Iririú')
ON CONFLICT DO NOTHING;

-- 3. Limpeza de dados de teste (Opcional, caso queira resetar os horários antes de rodar o scraper real)
-- DELETE FROM horarios;