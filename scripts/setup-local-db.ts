import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'local_oscs.db');

function setupDB() {
    const db = new Database(DB_PATH);

    // Create table
    db.exec(`
        CREATE TABLE IF NOT EXISTS oscs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cnpj TEXT UNIQUE,
            nome TEXT,
            uf TEXT,
            municipio TEXT,
            natureza_juridica TEXT,
            ano_fundacao INTEGER,
            cnae_primario_descricao TEXT,
            cnae_secundario_descricao TEXT
        )
    `);

    // Insert mock data
    const insert = db.prepare(`
        INSERT OR IGNORE INTO oscs (cnpj, nome, uf, municipio, natureza_juridica, ano_fundacao, cnae_primario_descricao, cnae_secundario_descricao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const mockOSCs = [
        ['11.111.111/0001-11', 'Associação Cultural de Jovens', 'SP', 'São Paulo', 'Associação Privada', 2010, 'Atividades de associações de defesa de direitos sociais', 'Atividades artísticas, criativas e de espetáculos'],
        ['22.222.222/0001-22', 'Instituto Educacional Transformar', 'RJ', 'Rio de Janeiro', 'Associação Privada', 2015, 'Educação infantil - pré-escola', 'Treinamento em desenvolvimento profissional e gerencial'],
        ['33.333.333/0001-33', 'Coletivo de Mulheres Empreendedoras', 'MG', 'Belo Horizonte', 'Associação Privada', 2018, 'Atividades de organizações associativas profissionais', 'Atividades de associações de defesa de direitos sociais'],
        ['44.444.444/0001-44', 'ONG Ambiental Raízes', 'BA', 'Salvador', 'Associação Privada', 2005, 'Atividades de organizações associativas ligadas à cultura e à arte', 'Atividades de defesa de direitos sociais'],
        ['55.555.555/0001-55', 'Centro Esportivo Comunitário', 'SP', 'Campinas', 'Associação Privada', 2012, 'Clubes sociais, esportivos e similares', 'Outras atividades de recreação e lazer'],
        // Generic name for testing grounding
        ['66.666.666/0001-66', 'Associação Comunitária de Moradores', 'RN', 'Portalegre', 'Associação Privada', 2000, 'Associações de moradores', 'Atividades de assistência social']
    ];

    db.transaction(() => {
        for (const osc of mockOSCs) {
            insert.run(...osc);
        }
    })();

    console.log(`Database setup complete at ${DB_PATH} with ${mockOSCs.length} mock records.`);
}

setupDB();
