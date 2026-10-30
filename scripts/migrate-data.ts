import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_FILE = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');

async function migrate() {
    try {
        const rawData = await fs.readFile(DATA_FILE, 'utf-8');
        let data = JSON.parse(rawData);

        data = data.map((item: any) => {
            const hasLoginWallFullText = item.full_text && (item.full_text.includes("Você precisa se logar") || item.full_text.includes("You need to sign in or sign up"));
            const hasLoginWallResumo = item.deep_metadata && item.deep_metadata.resumo_objetivo && (item.deep_metadata.resumo_objetivo.includes("login") || item.deep_metadata.resumo_objetivo.includes("cadastro") || item.deep_metadata.resumo_objetivo.includes("Prosas"));
            const isCompletedTextWithoutPdf = item.pipeline_status === 'COMPLETED' && item.deep_metadata && item.deep_metadata.fonte_dados === 'texto_pagina' && !item.pdf_link;

            if (hasLoginWallFullText || hasLoginWallResumo || isCompletedTextWithoutPdf) {
                delete item.deep_metadata;
                delete item.full_text;
                item.pipeline_status = 'NEW_FROM_API';
                console.log(`Resetting item ${item.id} to NEW_FROM_API due to login wall or missing PDF for completed text`);
            } else if (item.pdf_link && (!item.deep_metadata || !item.deep_metadata.drive_pdf_link)) {
                delete item.deep_metadata;
                item.pipeline_status = 'PENDING_EXTRACTION';
                console.log(`Setting item ${item.id} to PENDING_EXTRACTION to upload PDF to Drive`);
            }

            return item;
        });

        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
        console.log('Migration completed successfully.');
    } catch (e: any) {
        console.error('Migration failed:', e.message);
    }
}

migrate();
