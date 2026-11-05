import fs from 'fs/promises';
import path from 'path';

export async function load() {
  const dataPath = path.join(process.cwd(), 'src', 'data', 'daily_outbound_leads.json');
  try {
    const data = await fs.readFile(dataPath, 'utf-8');
    const leads = JSON.parse(data);
    return { leads };
  } catch (err) {
    return { leads: [] };
  }
}
