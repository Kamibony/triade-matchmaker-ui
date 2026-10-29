import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_FILE = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');

async function migrate() {
    try {
        const rawData = await fs.readFile(DATA_FILE, 'utf-8');
        let data = JSON.parse(rawData);

        data = data.map((item: any) => {
            delete item.deep_metadata;
            delete item.full_text;
            delete item.pdf_link;
            delete item.retry_count;
            delete item.last_error;
            delete item.pdf_error;
            delete item.pdf_skipped;

            item.pipeline_status = 'NEW_FROM_API';
            return item;
        });

        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
        console.log('Migration completed successfully.');
    } catch (e: any) {
        console.error('Migration failed:', e.message);
    }
}

migrate();