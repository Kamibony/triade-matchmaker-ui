import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
    const cnpj = params.cnpj;

    try {
        const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
            headers: {
                'User-Agent': 'TriadeMatchmaker/1.0',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return json(errorData, { status: response.status });
        }

        const data = await response.json();
        return json(data);
    } catch (error: any) {
        return json({ message: error.message || 'Erro de rede ao buscar dados do CNPJ no backend.' }, { status: 500 });
    }
};
