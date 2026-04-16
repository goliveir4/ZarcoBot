-- ==========================================
-- SCRIPT DE INICIALIZAÇÃO DO BANCO DE DADOS
-- Projeto: ZarcoBot 🚌
-- ==========================================

-- 1. Limpeza de tabelas (Para zerar o banco, se necessário)
DROP TABLE IF EXISTS horarios CASCADE;
DROP TABLE IF EXISTS terminais CASCADE;
DROP TABLE IF EXISTS linhas CASCADE;

-- 2. Criação da tabela de Linhas
-- Nota: O número da linha é UNIQUE para permitir atualizações (UPSERT)
CREATE TABLE linhas (
    id SERIAL PRIMARY KEY,
    numero VARCHAR(20) UNIQUE NOT NULL,
    nome VARCHAR(200) NOT NULL
);

-- 3. Criação da tabela de Terminais e Pontos de Origem
-- Nota: O nome é expansível até 200 caracteres para suportar ruas longas
-- e é UNIQUE para evitar duplicação de pontos dinâmicos
CREATE TABLE terminais (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(200) UNIQUE NOT NULL
);

-- 4. Criação da tabela de Horários
-- Nota: A constraint 'horarios_unique' impede que o robô insira o mesmo 
-- ônibus, no mesmo terminal e no mesmo horário mais de uma vez.
CREATE TABLE horarios (
    id SERIAL PRIMARY KEY,
    id_linha INT REFERENCES linhas(id) ON DELETE CASCADE,
    id_terminal_saida INT REFERENCES terminais(id) ON DELETE CASCADE,
    tipo_dia VARCHAR(50) NOT NULL,
    hora_saida TIME NOT NULL,
    CONSTRAINT horarios_unique UNIQUE (id_linha, id_terminal_saida, tipo_dia, hora_saida)
);